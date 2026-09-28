import type {
  AuthState,
  CancelSelector,
  ClientOptions,
  HttpMethod,
  IRes,
  PendingRequest,
  RequestConfig,
  TokenPair,
} from "../types";
import { linkSignals } from "../internal/cancel";
import { CoreClient } from "../internal/core-client";
import { resolveBaseUrl } from "../internal/env";
import { applyTransforms, errorMessage, failedResult, markCanceled } from "../internal/result";
import { storageFor } from "../internal/storage";
import { RequestTracker } from "../internal/tracker";
import { splitConfig } from "./host-options";
import { WorkerChannel } from "./worker-channel";

/**
 * Main-thread proxy to a worker running the real client.
 *
 * Tokens never enter this scope while the worker runs. When the worker cannot
 * start, the host falls back to an in-page `CoreClient` so the app keeps
 * working, exactly like `worker: false`.
 */
export class WorkerHost {
  private channel: WorkerChannel;
  /** Set when the worker could not boot; every call then runs in-page. */
  private inline: CoreClient | null = null;
  private listeners = new Set<(state: AuthState) => void>();
  /** Host-side so `api.cancel()` stays synchronous and works before the worker boots. */
  private tracker: RequestTracker;
  private baseUrl: string;

  constructor(private options: ClientOptions) {
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.tracker = new RequestTracker(options.cancel, this.baseUrl);
    this.channel = new WorkerChannel(options, this.baseUrl, {
      authChanged: (state) => this.emitAuth(state),
      bootFailed: () => {
        const inPage = { ...options, baseUrl: this.baseUrl, onAuthStateChanged: (state: AuthState) => this.emitAuth(state) };
        this.inline = new CoreClient(inPage, storageFor(options));
      },
    });
  }

  /** Whether requests currently run in the worker (false after a boot fallback). */
  get usesWorker(): boolean {
    return this.inline === null;
  }

  private emitAuth(state: AuthState): void {
    this.options.onAuthStateChanged?.(state);
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        /* one bad listener must not break the others */
      }
    }
  }

  /** Waits for boot, then runs in the page after a fallback or in the worker otherwise. */
  private async route<T>(inPage: (client: CoreClient) => Promise<T>, inWorker: () => Promise<T>): Promise<T> {
    await this.channel.whenReady();
    return this.inline ? inPage(this.inline) : inWorker();
  }

  // ── requests ───────────────────────────────────────────

  private async request<R>(method: HttpMethod, url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>> {
    const tracked = this.tracker.track(method, url, config as RequestConfig<unknown> | undefined);
    const { signal, release } = linkSignals([config?.signal, tracked?.signal]);
    const linked = config?.signal || tracked ? signal : undefined;

    try {
      return await this.route(
        // The host registry already tracks it; the in-page client must not track it twice.
        (client) => client.send<R>(method, url, body, { ...config, signal: linked, cancelable: false }),
        () => this.requestInWorker<R>(method, url, body, config, linked),
      );
    } finally {
      release();
      tracked?.release();
    }
  }

  private async requestInWorker<R>(
    method: HttpMethod,
    url: string,
    body: unknown,
    config: RequestConfig<R> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<IRes<R>> {
    const { serializable, beforeFunc } = splitConfig(config);
    let result: IRes<R>;
    try {
      const payload = beforeFunc ? beforeFunc(body) : body;
      // A ReadableStream cannot be structured-cloned; say so instead of a DataCloneError.
      if (typeof ReadableStream !== "undefined" && payload instanceof ReadableStream) {
        result = failedResult(
          "A ReadableStream body cannot be sent through a Web Worker. " +
            "Create this client with `worker: false`, or send a Blob/File/FormData instead.",
          new Error("Stream body is not transferable to a worker"),
        );
      } else {
        result = await this.channel.call<IRes<R>>(
          (id) => ({ kind: "request", id, method, url, body: payload, config: serializable }),
          signal,
        );
        // The transforms are functions: they couldn't cross the boundary, so they run here.
        applyTransforms(result as IRes<unknown>, (config ?? {}) as RequestConfig<unknown>);
      }
    } catch (error) {
      result = toFailure<R>(error);
    }

    // A cancellation is deliberate, so it must not raise the error toast.
    if (!result.status && !result.canceled && !config?.hideErrorMessage) this.options.onError?.(result);
    return result;
  }

  // ── cancellation ───────────────────────────────────────

  cancel(selector?: CancelSelector, reason?: string): number {
    return this.tracker.cancel(selector, reason);
  }

  pending(selector?: CancelSelector): PendingRequest[] {
    return this.tracker.pending(selector);
  }

  shouldThrowOnCancel(config?: RequestConfig<unknown>): boolean {
    return this.tracker.shouldThrowOnCancel(config);
  }

  get<R = unknown>(url: string, config?: RequestConfig<R>): Promise<IRes<R>> {
    return this.request<R>("GET", url, undefined, config);
  }
  post<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>> {
    return this.request<R>("POST", url, body, config);
  }
  put<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>> {
    return this.request<R>("PUT", url, body, config);
  }
  patch<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>> {
    return this.request<R>("PATCH", url, body, config);
  }
  delete<R = unknown>(url: string, config?: RequestConfig<R>): Promise<IRes<R>> {
    return this.request<R>("DELETE", url, undefined, config);
  }

  // ── auth ───────────────────────────────────────────────

  login<R = unknown>(body: unknown, config?: RequestConfig<R>): Promise<IRes<R>> {
    return this.route(
      (client) => client.login(body, config),
      async () => {
        const { serializable } = splitConfig(config);
        const result = await this.channel
          .call<IRes<R>>((id) => ({ kind: "login", id, body, config: serializable }))
          .catch((error: unknown) => toFailure<R>(error));
        if (!result.status && !config?.hideErrorMessage) this.options.onError?.(result);
        return result;
      },
    );
  }

  logout<R = unknown>(config?: RequestConfig<R>): Promise<IRes<R>> {
    return this.route(
      (client) => client.logout(config),
      () =>
        this.channel
          .call<IRes<R>>((id) => ({ kind: "logout", id, config: splitConfig(config).serializable }))
          .catch((error: unknown) => toFailure<R>(error)),
    );
  }

  setTokens(tokens: TokenPair): Promise<void> {
    return this.route(
      (client) => client.setTokens(tokens),
      () => this.channel.call<void>((id) => ({ kind: "setTokens", id, tokens })),
    );
  }

  restoreSession(url?: string): Promise<AuthState> {
    return this.route(
      (client) => client.restoreSession(url),
      () => this.channel.call<AuthState>((id) => ({ kind: "restoreSession", id, url })),
    );
  }

  getAuthState(): Promise<AuthState> {
    return this.route(
      (client) => client.getAuthState(),
      () => this.channel.call<AuthState>((id) => ({ kind: "authState", id })),
    );
  }

  refresh(): Promise<boolean> {
    return this.route(
      (client) => client.refresh(),
      () => this.channel.call<boolean>((id) => ({ kind: "refresh", id })),
    );
  }

  getAccessToken(): Promise<string | undefined> {
    return this.route(
      (client) => client.getAccessToken(),
      () => this.channel.call<string | undefined>((id) => ({ kind: "accessToken", id })),
    );
  }

  /**
   * No immediate call with a cached state: the worker hydrates asynchronously,
   * and firing `{ isAuthenticated: false }` first would redirect apps to
   * /login before the real state arrives. Use `getAuthState()` for a snapshot.
   */
  onAuthStateChange(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.tracker.cancel(undefined, "client destroyed");
    this.channel.destroy();
    this.inline?.destroy();
    this.listeners.clear();
  }
}

/** A thrown RPC error as a result: an abort becomes a cancellation, anything else a client-side failure. */
function toFailure<R>(error: unknown): IRes<R> {
  const result = failedResult<R>(errorMessage(error, "Worker request failed"), error);
  if ((error as Error | undefined)?.name === "AbortError") markCanceled(result as IRes<unknown>, error);
  return result;
}
