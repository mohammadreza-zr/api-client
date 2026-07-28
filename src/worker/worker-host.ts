import type {
  AuthState,
  CancelSelector,
  ClientOptions,
  HttpMethod,
  IRes,
  PendingRequest,
  RequestConfig,
  TokenPair,
  TokenStorage,
} from "../types";
import type { HostMessage, SerializableConfig, SerializableOptions, WorkerMessage } from "./protocol";
import {
  CancelRegistry,
  cancelMessage,
  groupsOf,
  isCancelable,
  linkSignals,
  previewUrl,
  reasonOf,
  resolveCancelDefaults,
  type CancelDefaults,
} from "../internal/cancel";
import { detectBaseUrl } from "../internal/env";
import { resolveStorage } from "../internal/storage";
import { WORKER_SOURCE } from "./worker-source";

/**
 * Main-thread proxy to a worker running the real client.
 *
 * Tokens never enter this scope. Options and configs are split: everything
 * serializable is forwarded, and the function hooks are applied here around
 * the round trip so behaviour matches main-thread mode exactly.
 */
export class WorkerHost {
  private worker: Worker;
  private objectUrl: string | null = null;
  private seq = 0;
  /** In-flight RPC calls awaiting a worker reply, keyed by message id. */
  private calls = new Map<
    number,
    { resolve: (value: never) => void; reject: (error: Error) => void }
  >();
  private ready: Promise<void>;
  private listeners = new Set<(state: AuthState) => void>();
  private hooks: Pick<ClientOptions, "onAuthStateChanged" | "onAuthFailure" | "onError" | "onLog">;
  private lastState: AuthState = { isAuthenticated: false, expiresAt: null };
  private xsrfCookieName?: string;
  private xsrfHeaderName: string;
  private csrfProvider?: () => string | undefined;
  /** Main-thread storage the worker persists through. `null` for memory. */
  private storage: TokenStorage | null = null;
  /**
   * The cancel registry lives here, not in the worker.
   *
   * `api.cancel()` has to be synchronous and has to work before the worker has
   * even finished booting, so the host tracks requests and translates a
   * cancellation into the `abort` message the worker already understands.
   */
  private cancelDefaults: CancelDefaults;
  private registry = new CancelRegistry();
  /** Maps a registry entry to the in-flight worker request id. */
  private workerIds = new Map<number, number>();
  private baseUrl: string;

  constructor(options: ClientOptions) {
    this.cancelDefaults = resolveCancelDefaults(options.cancel);
    this.baseUrl = (options.baseUrl ?? (detectBaseUrl() || pageOrigin())).replace(/\/+$/, "");
    this.hooks = {
      onAuthStateChanged: options.onAuthStateChanged,
      onAuthFailure: options.onAuthFailure,
      onError: options.onError,
      onLog: options.onLog,
    };

    // CSRF is resolved here, not in the worker: `document.cookie` only exists
    // on the main thread, and a provider function cannot be cloned across.
    this.xsrfCookieName = options.xsrfCookieName;
    this.xsrfHeaderName = options.xsrfHeaderName ?? "X-CSRF-Token";
    this.csrfProvider = options.getCsrfToken;

    /*
     * Own the storage adapter here, on the main thread.
     *
     * `localStorage` / `sessionStorage` / `document.cookie` are Window APIs
     * that do not exist inside a worker, so a worker-side adapter silently
     * dropped every write and sessions never survived a reload. The worker
     * asks us to persist instead. A caller-supplied adapter object also works
     * this way — it cannot be cloned across the boundary either.
     */
    const kind = options.storage ?? "memory";
    this.storage =
      kind === "memory" ? null : resolveStorage(kind, options.storageKey ?? "apiclient");

    const blob = new Blob([WORKER_SOURCE], { type: "text/javascript" });
    this.objectUrl = URL.createObjectURL(blob);
    this.worker = new Worker(this.objectUrl);

    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => this.receive(event.data);
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "Worker crashed");
      for (const [, entry] of this.calls) entry.reject(error);
      this.calls.clear();
    };

    this.ready = new Promise<void>((resolve) => {
      const onReady = (event: MessageEvent<WorkerMessage>) => {
        if (event.data?.kind === "ready") {
          this.worker.removeEventListener("message", onReady);
          resolve();
        }
      };
      this.worker.addEventListener("message", onReady);
    });

    this.dispatch({ kind: "init", options: toSerializableOptions(options) });
  }

  // ── plumbing ───────────────────────────────────────────

  private dispatch(msg: HostMessage): void {
    this.worker.postMessage(msg);
  }

  private receive(msg: WorkerMessage): void {
    switch (msg.kind) {
      case "result":
      case "authState":
      case "refreshed":
      case "void": {
        const id = (msg as { id: number }).id;
        const entry = this.calls.get(id);
        if (!entry) return;
        this.calls.delete(id);
        if (msg.kind === "result") entry.resolve(msg.result as never);
        else if (msg.kind === "authState") entry.resolve(msg.state as never);
        else if (msg.kind === "refreshed") entry.resolve(msg.ok as never);
        else entry.resolve(undefined as never);
        break;
      }

      case "failure": {
        const entry = this.calls.get(msg.id);
        if (!entry) return;
        this.calls.delete(msg.id);
        entry.reject(new Error(msg.message));
        break;
      }

      case "authChanged": {
        this.lastState = msg.state;
        this.hooks.onAuthStateChanged?.(msg.state);
        for (const listener of this.listeners) {
          try {
            listener(msg.state);
          } catch {
            /* ignore */
          }
        }
        break;
      }

      case "authFailure":
        this.hooks.onAuthFailure?.();
        break;

      case "log":
        if (this.hooks.onLog) this.hooks.onLog(msg.entry as never);
        else console.info("[api-client]", msg.entry);
        break;

      case "storage":
        void this.serveStorage(msg.id, msg.op, msg.tokens);
        break;
    }
  }

  /**
   * Runs one storage operation for the worker and posts the answer back.
   * Always replies, even on failure, so the worker never waits on a dead call.
   */
  private async serveStorage(
    id: number,
    op: "get" | "set" | "clear",
    tokens?: TokenPair,
  ): Promise<void> {
    let result: TokenPair | null = null;
    try {
      if (!this.storage) {
        result = null;
      } else if (op === "get") {
        result = (await this.storage.get()) ?? null;
      } else if (op === "set" && tokens) {
        await this.storage.set(tokens);
      } else if (op === "clear") {
        await this.storage.clear();
      }
    } catch {
      // Quota, Safari private mode, disabled cookies — never fatal.
      result = null;
    }

    try {
      this.dispatch({ kind: "storageResult", id, tokens: result });
    } catch {
      /* worker already terminated */
    }
  }

  private async call<T>(
    build: (id: number) => HostMessage,
    signal?: AbortSignal | null,
    onId?: (id: number) => void,
  ): Promise<T> {
    await this.ready;
    const id = ++this.seq;
    onId?.(id);

    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as never, reject });

      if (signal) {
        if (signal.aborted) {
          this.calls.delete(id);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            // Forward the reason so the worker's engine can report it.
            this.dispatch({ kind: "abort", id, reason: reasonOf(signal.reason) });
          },
          { once: true },
        );
      }

      this.dispatch(build(id));
    });
  }

  // ── requests ───────────────────────────────────────────

  /** Reads the CSRF token on the main thread, where cookies are visible. */
  private csrfToken(): string | undefined {
    if (this.csrfProvider) {
      try {
        return this.csrfProvider();
      } catch {
        return undefined;
      }
    }
    if (!this.xsrfCookieName || typeof document === "undefined") return undefined;
    const escaped = this.xsrfCookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
    if (!match) return undefined;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  private async request<R>(
    method: HttpMethod,
    url: string,
    body?: unknown,
    config?: RequestConfig<R>,
  ): Promise<IRes<R>> {
    const { serializable, beforeFunc, afterFunc, beforeSelectOptions, signal } = splitConfig(config);

    const payload = beforeFunc ? beforeFunc(body) : body;

    // A ReadableStream cannot be structured-cloned into the worker. Rather
    // than let postMessage throw an opaque DataCloneError, say so plainly.
    if (typeof ReadableStream !== "undefined" && payload instanceof ReadableStream) {
      const failure: IRes<R> = {
        statusCode: 0,
        status: false,
        message:
          "A ReadableStream body cannot be sent through a Web Worker. " +
          "Create this client with `worker: false`, or send a Blob/File/FormData instead.",
        loading: false,
        error: new Error("Stream body is not transferable to a worker"),
      };
      if (!config?.hideErrorMessage) this.hooks.onError?.(failure);
      return failure;
    }

    // Mirror the CSRF cookie into a header before the config crosses over.
    let forwarded = serializable;
    if (method !== "GET") {
      const csrf = this.csrfToken();
      if (csrf) {
        const existing = forwarded?.headers ?? {};
        const alreadySet = Object.keys(existing).some(
          (k) => k.toLowerCase() === this.xsrfHeaderName.toLowerCase(),
        );
        if (!alreadySet) {
          forwarded = { ...forwarded, headers: { ...existing, [this.xsrfHeaderName]: csrf } };
        }
      }
    }

    /*
     * Track on the host, abort in the worker.
     *
     * The registry cannot live in the worker: `api.cancel()` is synchronous
     * and may fire before the worker has finished booting. So the host owns
     * the bookkeeping, and a cancellation becomes the `abort` message the
     * worker already handles — the real `fetch` genuinely stops.
     */
    const tracked = isCancelable(method, config as RequestConfig<unknown> | undefined, this.cancelDefaults)
      ? this.registry.track({
          method,
          url: previewUrl(url, this.baseUrl, config as RequestConfig<unknown> | undefined),
          key: config?.cancelKey,
          groups: groupsOf(config as RequestConfig<unknown> | undefined),
          takeLatest: config?.takeLatest ?? this.cancelDefaults.takeLatest,
        })
      : undefined;

    // Merge the caller's signal with the registry's, so either can stop it.
    const { signal: linked, release } = linkSignals([signal, tracked?.signal]);

    let result: IRes<R>;
    try {
      result = await this.call<IRes<R>>(
        (id) => ({ kind: "request", id, method, url, body: payload, config: forwarded }),
        signal || tracked ? linked : undefined,
        (id) => {
          if (tracked) this.workerIds.set(tracked.id, id);
        },
      );
    } catch (error) {
      const canceled = (error as Error)?.name === "AbortError";
      result = {
        statusCode: canceled ? 0 : 500,
        status: false,
        message: canceled
          ? cancelMessage(error)
          : ((error as Error)?.message ?? "Worker request failed"),
        loading: false,
        error,
      };
      if (canceled) {
        result.canceled = true;
        const reason = reasonOf(error);
        if (reason) result.cancelReason = reason;
      }
    } finally {
      release();
      if (tracked) {
        this.workerIds.delete(tracked.id);
        tracked.release();
      }
    }

    // Re-apply the transforms the structured-clone boundary could not carry.
    if (result.status) {
      let data: unknown = result.data;
      if (beforeSelectOptions) data = beforeSelectOptions(data as never);
      if (afterFunc) data = afterFunc(data as never);
      result.data = data as R;
    }

    // A cancellation is deliberate, so it must not raise the error toast.
    if (!result.status && !result.canceled && !config?.hideErrorMessage) {
      this.hooks.onError?.(result);
    }

    return result;
  }

  // ── cancellation ───────────────────────────────────────

  /** Cancels matching in-flight requests. Returns how many were stopped. */
  cancel(selector?: CancelSelector, reason?: string): number {
    return this.registry.cancel(selector, reason);
  }

  /** The cancelable requests currently in flight. */
  pending(selector?: CancelSelector): PendingRequest[] {
    return this.registry.pending(selector);
  }

  /**
   * Whether a canceled request should reject.
   *
   * `undefined` means "no explicit preference" and lets the caller fall back
   * to `throwError`, so a client built for the envelope style keeps resolving.
   */
  shouldThrowOnCancel(config?: RequestConfig<unknown>): boolean | undefined {
    return config?.throwOnCancel ?? this.cancelDefaults.throwOnCancel;
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

  async login<R = unknown>(body: unknown, config?: RequestConfig<R>): Promise<IRes<R>> {
    const { serializable } = splitConfig(config);
    const result = await this.call<IRes<R>>((id) => ({ kind: "login", id, body, config: serializable }));
    if (!result.status && !config?.hideErrorMessage) this.hooks.onError?.(result);
    return result;
  }

  async logout<R = unknown>(config?: RequestConfig<R>): Promise<IRes<R>> {
    const { serializable } = splitConfig(config);
    return this.call<IRes<R>>((id) => ({ kind: "logout", id, config: serializable }));
  }

  setTokens(tokens: TokenPair): Promise<void> {
    return this.call<void>((id) => ({ kind: "setTokens", id, tokens }));
  }

  restoreSession(url?: string): Promise<AuthState> {
    return this.call<AuthState>((id) => ({ kind: "restoreSession", id, url }));
  }

  getAuthState(): Promise<AuthState> {
    return this.call<AuthState>((id) => ({ kind: "authState", id }));
  }

  async refresh(): Promise<string | null> {
    const ok = await this.call<boolean>((id) => ({ kind: "refresh", id }));
    // The token itself intentionally never leaves the worker.
    return ok ? "" : null;
  }

  onAuthStateChange(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    listener(this.lastState);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    try {
      this.dispatch({ kind: "destroy" });
    } catch {
      /* already gone */
    }
    this.registry.cancel(undefined, "client destroyed");
    this.workerIds.clear();
    this.worker.terminate();
    for (const [, entry] of this.calls) entry.reject(new Error("Client destroyed"));
    this.calls.clear();
    this.listeners.clear();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}

// ── helpers ──────────────────────────────────────────────

/** The page origin, so relative URLs behave the same inside a Blob worker. */
function pageOrigin(): string {
  try {
    return typeof location !== "undefined" && location.origin && location.origin !== "null"
      ? location.origin
      : "";
  } catch {
    return "";
  }
}

function toSerializableOptions(options: ClientOptions): SerializableOptions {
  const {
    storage,
    extractTokens: _extract,
    buildRefreshBody: _build,
    onAuthStateChanged: _a,
    onAuthFailure: _b,
    onError: _c,
    onLog: _d,
    worker: _e,
    // A function cannot be structured-cloned; the host resolves the token and
    // forwards the resulting string with each request instead.
    getCsrfToken: _f,
    // Cancellation is tracked on the host, which forwards `abort` messages.
    cancel: _g,
    ...rest
  } = options;

  return {
    ...rest,
    /*
     * Forward only the *kind*, so the worker knows whether to persist at all.
     * A custom adapter object is served from the host, and is reported to the
     * worker as "local" purely so it opts into the storage bridge.
     */
    storage: typeof storage === "object" ? "local" : storage,
    /*
     * Resolve the base URL here, on the main thread.
     *
     * Two reasons this cannot be left to the worker:
     *
     * 1. The worker runs from a Blob, so no bundler touched its source and
     *    `process.env` / `import.meta.env` are both absent — detection there
     *    would always yield "".
     *
     * 2. A worker created from `URL.createObjectURL` has a `blob:` base URL,
     *    and a relative request cannot resolve against it (`new URL("/me",
     *    "blob:http://host/uuid")` throws). On the main thread a relative URL
     *    would simply hit the page origin, so fall back to that origin to keep
     *    worker and inline mode behaving identically.
     */
    baseUrl: options.baseUrl ?? (detectBaseUrl() || pageOrigin()),
  };
}

function splitConfig<R>(config?: RequestConfig<R>): {
  serializable?: SerializableConfig;
  beforeFunc?: (body: unknown) => unknown;
  afterFunc?: (data: never) => unknown;
  beforeSelectOptions?: (data: never) => unknown;
  signal?: AbortSignal | null;
} {
  if (!config) return {};

  const {
    beforeFunc,
    afterFunc,
    beforeSelectOptions,
    signal,
    // Cancellation metadata stays on the host: it drives the registry here,
    // and the worker only ever needs the resulting `abort` message.
    cancelable: _cancelable,
    cancelKey: _cancelKey,
    cancelGroup: _cancelGroup,
    takeLatest: _takeLatest,
    throwOnCancel: _throwOnCancel,
    ...rest
  } = config;

  return {
    serializable: rest as SerializableConfig,
    beforeFunc,
    afterFunc: afterFunc as ((data: never) => unknown) | undefined,
    beforeSelectOptions: beforeSelectOptions as ((data: never) => unknown) | undefined,
    signal,
  };
}
