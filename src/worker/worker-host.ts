import type {
  AuthState,
  ClientOptions,
  HttpMethod,
  IRes,
  RequestConfig,
  TokenPair,
} from "../types";
import type { HostMessage, SerializableConfig, SerializableOptions, WorkerMessage } from "./protocol";
import { detectBaseUrl } from "../internal/env";
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
  private pending = new Map<
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

  constructor(options: ClientOptions) {
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

    const blob = new Blob([WORKER_SOURCE], { type: "text/javascript" });
    this.objectUrl = URL.createObjectURL(blob);
    this.worker = new Worker(this.objectUrl);

    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => this.receive(event.data);
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "Worker crashed");
      for (const [, entry] of this.pending) entry.reject(error);
      this.pending.clear();
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
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (msg.kind === "result") entry.resolve(msg.result as never);
        else if (msg.kind === "authState") entry.resolve(msg.state as never);
        else if (msg.kind === "refreshed") entry.resolve(msg.ok as never);
        else entry.resolve(undefined as never);
        break;
      }

      case "failure": {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
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
    }
  }

  private async call<T>(build: (id: number) => HostMessage, signal?: AbortSignal | null): Promise<T> {
    await this.ready;
    const id = ++this.seq;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as never, reject });

      if (signal) {
        if (signal.aborted) {
          this.pending.delete(id);
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            this.dispatch({ kind: "abort", id });
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

    let result: IRes<R>;
    try {
      result = await this.call<IRes<R>>(
        (id) => ({ kind: "request", id, method, url, body: payload, config: forwarded }),
        signal,
      );
    } catch (error) {
      result = {
        statusCode: (error as Error)?.name === "AbortError" ? 0 : 500,
        status: false,
        message: (error as Error)?.message ?? "Worker request failed",
        loading: false,
        error,
      };
    }

    // Re-apply the transforms the structured-clone boundary could not carry.
    if (result.status) {
      let data: unknown = result.data;
      if (beforeSelectOptions) data = beforeSelectOptions(data as never);
      if (afterFunc) data = afterFunc(data as never);
      result.data = data as R;
    }

    if (!result.status && !config?.hideErrorMessage) {
      this.hooks.onError?.(result);
    }

    return result;
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
    this.worker.terminate();
    for (const [, entry] of this.pending) entry.reject(new Error("Client destroyed"));
    this.pending.clear();
    this.listeners.clear();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}

// ── helpers ──────────────────────────────────────────────

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
    ...rest
  } = options;

  return {
    ...rest,
    /*
     * Resolve the base URL here, on the main thread.
     *
     * The worker runs from a Blob, so the bundler never touched its source and
     * `process.env` / `import.meta.env` are both absent inside it. Detecting
     * there would always yield `""` and every relative URL would hit the page
     * origin instead of the API.
     */
    baseUrl: options.baseUrl ?? detectBaseUrl() ?? "",
    // A custom storage object cannot cross the boundary; fall back to memory.
    storage: typeof storage === "object" ? undefined : storage,
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

  const { beforeFunc, afterFunc, beforeSelectOptions, signal, ...rest } = config;

  return {
    serializable: rest as SerializableConfig,
    beforeFunc,
    afterFunc: afterFunc as ((data: never) => unknown) | undefined,
    beforeSelectOptions: beforeSelectOptions as ((data: never) => unknown) | undefined,
    signal,
  };
}
