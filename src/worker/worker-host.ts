import type {
  AuthState,
  ClientOptions,
  HttpMethod,
  IRes,
  RequestConfig,
  TokenPair,
} from "../types";
import type { HostMessage, SerializableConfig, SerializableOptions, WorkerMessage } from "./protocol";
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

  constructor(options: ClientOptions) {
    this.hooks = {
      onAuthStateChanged: options.onAuthStateChanged,
      onAuthFailure: options.onAuthFailure,
      onError: options.onError,
      onLog: options.onLog,
    };

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

  private async request<R>(
    method: HttpMethod,
    url: string,
    body?: unknown,
    config?: RequestConfig<R>,
  ): Promise<IRes<R>> {
    const { serializable, beforeFunc, afterFunc, beforeSelectOptions, signal } = splitConfig(config);

    const payload = beforeFunc ? beforeFunc(body) : body;

    let result: IRes<R>;
    try {
      result = await this.call<IRes<R>>(
        (id) => ({ kind: "request", id, method, url, body: payload, config: serializable }),
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
    ...rest
  } = options;

  return {
    ...rest,
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
