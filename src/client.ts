import type {
  AuthState,
  ClientOptions,
  IRes,
  RequestConfig,
  TokenPair,
} from "./types";
import { ApiError } from "./types";
import { CoreClient } from "./internal/core-client";
import { hasWorker, isServer } from "./internal/env";
import { WorkerHost } from "./worker/worker-host";
import { WORKER_SOURCE } from "./worker/worker-source";

/**
 * The client returned by `createClient`.
 * Identical in every environment: worker, main thread, and server.
 */
export interface ApiClient {
  get<R = unknown>(url: string, config?: RequestConfig<R>): Promise<IRes<R>>;
  post<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
  put<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
  patch<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
  delete<R = unknown>(url: string, config?: RequestConfig<R>): Promise<IRes<R>>;

  /** Authenticate and store the returned tokens. */
  login<R = unknown>(body: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;

  /** Call the logout endpoint and clear tokens in every tab. */
  logout<R = unknown>(config?: RequestConfig<R>): Promise<IRes<R>>;

  /** Seed tokens from SSR, an OAuth callback, or your own login flow. */
  setTokens(tokens: TokenPair): Promise<void>;

  /** Force a token refresh. Returns `null` when it failed. */
  refresh(): Promise<string | null>;

  /** Current auth state. Never contains tokens. */
  getAuthState(): Promise<AuthState>;

  /** Subscribe to auth changes. Returns an unsubscribe function. */
  onAuthStateChange(listener: (state: AuthState) => void): () => void;

  /** Whether requests are running inside a Web Worker. */
  readonly isWorker: boolean;

  /** Tear down the worker and cross-tab channel. */
  destroy(): void;
}

/**
 * The surface both implementations share. Declaring it explicitly is what
 * guarantees worker mode and main-thread mode cannot drift apart.
 */
type Implementation = Pick<
  ApiClient,
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "login"
  | "logout"
  | "setTokens"
  | "refresh"
  | "getAuthState"
  | "onAuthStateChange"
  | "destroy"
>;

/**
 * Creates an API client.
 *
 * Works unchanged in React, Vue, Svelte, Angular, Next.js, Nuxt, plain scripts
 * and on the server. Requests run inside a Web Worker when the environment
 * supports one, so tokens never touch the main thread; otherwise the very same
 * implementation runs inline.
 *
 * ```ts
 * import { createClient } from "@mohammadreza-zr/api-client";
 *
 * export const api = createClient({ baseUrl: "https://api.example.com" });
 *
 * const { data, status } = await api.get<User[]>("/users");
 * ```
 */
export function createClient(options: ClientOptions = {}): ApiClient {
  const wantsWorker = options.worker !== false;
  const canUseWorker =
    wantsWorker &&
    !isServer() &&
    hasWorker() &&
    WORKER_SOURCE.length > 0 &&
    // A custom storage object can't be cloned into a worker.
    typeof options.storage !== "object" &&
    !options.extractTokens &&
    !options.buildRefreshBody;

  if (canUseWorker) {
    try {
      return wrap(new WorkerHost(options), true, options);
    } catch {
      // Blob workers are blocked by some CSPs — fall back silently.
    }
  }

  return wrap(new CoreClient(options), false, options);
}

/** Applies `throwError` uniformly on top of either implementation. */
function wrap(impl: Implementation, isWorker: boolean, options: ClientOptions): ApiClient {
  // Throwing by default is what react-query, SWR and Vue Query expect.
  const throwByDefault = options.throwError !== false;

  const guard = async <R>(
    run: () => Promise<IRes<R>>,
    config?: RequestConfig<R>,
  ): Promise<IRes<R>> => {
    const result = await run();
    // Per-request config wins, so a client-wide default can be opted out of.
    const shouldThrow = config?.throwError ?? throwByDefault;
    if (!result.status && shouldThrow) throw new ApiError(result);
    return result;
  };

  return {
    get: (url, config) => guard(() => impl.get(url, config), config),
    post: (url, body, config) => guard(() => impl.post(url, body, config), config),
    put: (url, body, config) => guard(() => impl.put(url, body, config), config),
    patch: (url, body, config) => guard(() => impl.patch(url, body, config), config),
    delete: (url, config) => guard(() => impl.delete(url, config), config),
    login: (body, config) => guard(() => impl.login(body, config), config),
    logout: (config) => impl.logout(config),
    setTokens: (tokens) => impl.setTokens(tokens),
    refresh: () => impl.refresh(),
    getAuthState: () => impl.getAuthState(),
    onAuthStateChange: (listener) => impl.onAuthStateChange(listener),
    isWorker,
    destroy: () => impl.destroy(),
  } as ApiClient;
}
