import type {
  AuthState,
  CancelScope,
  CancelSelector,
  ClientOptions,
  HttpMethod,
  IRes,
  PendingRequest,
  RequestConfig,
  SocketTokenOptions,
  TokenPair,
} from "./types";
import { ApiError } from "./types";
import { CoreClient } from "./internal/core-client";
import { extractSocketToken } from "./internal/extract";
import { storageFor } from "./internal/storage";
import { hasWorker, isServer, isWorkerScope, resolveBaseUrl } from "./internal/env";
import { WorkerHost } from "./worker/worker-host";
import { WORKER_SOURCE } from "./worker/worker-source";
import {
  configureWith,
  extendWith,
  sendThrough,
  type ApiPlugin,
  type PluginExtensions,
  type PluginRequest,
} from "./plugin";

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

  /**
   * Force a token refresh. Resolves `true` when the session is usable again,
   * `false` when the refresh failed.
   *
   * Returns a boolean rather than the new token: the token never leaves the
   * worker, and whether the refresh *worked* is all a caller can act on.
   * `false` only clears the session when the refresh endpoint rejected the
   * authentication (401/403). Server errors (5xx) and network failures leave
   * the session intact — a blip is not a logout.
   */
  refresh(): Promise<boolean>;

  /**
   * Asks your server for a WebSocket / socket.io credential and returns it.
   *
   * The request is an ordinary authenticated call (token attached, refreshed
   * on 401), so the access token itself never leaves the worker. The response
   * may be the token as a string, or `{ token }`, `{ ticket }` or
   * `{ socketToken }`, optionally wrapped in `{ data }`. Rejects with an
   * `ApiError` when the call fails or the response carries no token.
   *
   * ```ts
   * const socket = io(URL, {
   *   auth: async (cb) => cb({ token: await api.getSocketToken("/auth/socket-ticket") }),
   * });
   * ```
   */
  getSocketToken(url: string, options?: SocketTokenOptions): Promise<string>;

  /**
   * The current access token, refreshed first when it is about to expire —
   * for a socket server that accepts the API token itself. Requires
   * `exposeTokens: true` (rejects otherwise); resolves `undefined` when there
   * is no usable token, and always in cookie mode, where the token is httpOnly.
   */
  getAccessToken(): Promise<string | undefined>;

  /** Current auth state. Never contains tokens. */
  getAuthState(): Promise<AuthState>;

  /**
   * Establishes whether a session already exists, for `authMode: "cookie"`.
   *
   * httpOnly cookies are invisible to JavaScript, so after a page reload the
   * client cannot tell a logged-in visitor from a logged-out one until it
   * asks the server. Call this once on startup:
   *
   * ```ts
   * const state = await api.restoreSession("/api/auth/me");
   * ```
   *
   * Pass a probe endpoint to also populate `state.user`, or omit it to try
   * the refresh endpoint instead. In header mode this resolves with the
   * rehydrated state and makes no request.
   */
  restoreSession(url?: string): Promise<AuthState>;

  /** Subscribe to auth changes. Returns an unsubscribe function. */
  onAuthStateChange(listener: (state: AuthState) => void): () => void;

  /**
   * Cancels in-flight requests. Returns how many were stopped.
   *
   * Requires the `cancel` option (or a per-request `cancelable`) — only
   * tracked requests can be canceled.
   *
   * ```ts
   * api.cancel();                          // everything in flight
   * api.cancel("/api/v1/products");        // by URL pattern, key or group
   * api.cancel("search");                  // by cancelKey
   * api.cancel({ url: "/users/:id", method: "GET" });
   * api.cancel((r) => Date.now() - r.startedAt > 10_000);
   * ```
   *
   * Cancelled requests reject with an `ApiError` carrying `canceled: true`,
   * or resolve with `{ canceled: true, statusCode: 0 }` when `throwOnCancel`
   * is `false`. `onError` is never fired for them.
   *
   * Safe to call at any time — with nothing in flight it simply returns `0`.
   */
  cancel(selector?: CancelSelector, reason?: string): number;

  /**
   * The cancelable requests currently in flight, optionally filtered by the
   * same selectors `cancel()` accepts.
   *
   * ```ts
   * if (api.pending("/api/v1/products").length) showSpinner();
   * ```
   */
  pending(selector?: CancelSelector): PendingRequest[];

  /**
   * Creates a cancellation scope — a wrapper whose requests are all tagged, so
   * one call stops the lot. The idiomatic answer to "cancel everything this
   * page/modal started".
   *
   * ```ts
   * const scope = api.cancelScope("product-modal");
   * const { data } = await scope.get("/api/v1/products/12");
   * // when the modal closes
   * scope.cancel();
   * ```
   *
   * Requests made through a scope are cancelable **by default**, whatever the
   * client-wide setting — creating a scope is itself the opt-in. Writes still
   * need `cancelable: true`, since a canceled write may already have landed.
   */
  cancelScope(name?: string): CancelScope;

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
  | "getAccessToken"
  | "getAuthState"
  | "restoreSession"
  | "onAuthStateChange"
  | "cancel"
  | "pending"
  | "destroy"
> & {
  /** Resolves `throwOnCancel` for a config, using the client-wide default. */
  shouldThrowOnCancel(config?: RequestConfig<unknown>): boolean;
  /** Whether requests run in a worker right now; absent means never. */
  readonly usesWorker?: boolean;
};

/**
 * Creates an API client.
 *
 * Works unchanged in React, Vue, Svelte, Angular, Next.js, Nuxt, plain scripts
 * and on the server. Requests run inside a Web Worker when the environment
 * supports one, so tokens never touch the main thread; otherwise the very same
 * implementation runs inline.
 *
 * ```ts
 * import { createClient } from "@mrzr/api-client";
 *
 * export const api = createClient({ baseUrl: "https://api.example.com" });
 *
 * const { data, status } = await api.get<User[]>("/users");
 * ```
 */
export function createClient<const P extends readonly ApiPlugin[] = []>(
  clientOptions: ClientOptions & { plugins?: P } = {},
): ApiClient & PluginExtensions<P> {
  const plugins = clientOptions.plugins ?? [];
  const options = configureWith(plugins, clientOptions);
  const wantsWorker = options.worker !== false;
  const canUseWorker =
    wantsWorker &&
    !isServer() &&
    // Already inside a worker: run inline rather than nesting another one.
    !isWorkerScope() &&
    hasWorker() &&
    WORKER_SOURCE.length > 0 &&
    // A custom storage object stays on the main thread and is served to the
    // worker over the storage bridge, so it no longer forces inline mode.
    //
    // Only the *function* forms of extractTokens / buildRefreshBody force
    // inline mode: functions cannot be structured-cloned into the worker.
    // The declarative TokenFieldMap / RefreshBodyConfig forms are plain data
    // and keep worker isolation.
    typeof options.extractTokens !== "function" &&
    typeof options.buildRefreshBody !== "function";

  let impl: Implementation | undefined;
  if (canUseWorker) {
    try {
      impl = new WorkerHost(options);
    } catch {
      // Blob workers are blocked by some CSPs — fall back silently.
    }
  }
  impl ??= new CoreClient({ ...options, baseUrl: resolveBaseUrl(options.baseUrl) }, storageFor(options));

  const client = wrap(impl, options, plugins);
  extendWith(client, plugins);
  return client as ApiClient & PluginExtensions<P>;
}

/** Calls the implementation's verb for a request that may have been rewritten by plugins. */
function dispatch(impl: Implementation, { method, url, body, config }: PluginRequest): Promise<IRes<unknown>> {
  if (method === "GET") return impl.get(url, config);
  if (method === "DELETE") return impl.delete(url, config);
  const verb = method.toLowerCase() as Lowercase<Exclude<HttpMethod, "GET" | "DELETE">>;
  return impl[verb](url, body, config);
}

/** Applies `throwError` uniformly on top of either implementation. */
function wrap(impl: Implementation, options: ClientOptions, plugins: readonly ApiPlugin[]): ApiClient {
  // Throwing by default is what react-query, SWR and Vue Query expect.
  const throwByDefault = options.throwError !== false;

  const guard = async <R>(
    run: () => Promise<IRes<R>>,
    config?: RequestConfig<R>,
  ): Promise<IRes<R>> => {
    const result = await run();
    if (result.status) return result;

    /*
     * Cancellation is governed by `throwOnCancel`, not `throwError`.
     *
     * The two are deliberately independent: a cancellation is something the
     * app asked for, so it resolves by default even on a throwing client.
     * Rejecting instead makes TanStack Query retry the request that was just
     * canceled, and turns the ordinary `useEffect` async pattern into an
     * unhandled rejection. Opt back in with `throwOnCancel: true`.
     */
    const shouldThrow = result.canceled
      ? impl.shouldThrowOnCancel(config as RequestConfig<unknown> | undefined)
      : (config?.throwError ?? throwByDefault);

    if (shouldThrow) throw new ApiError(result);
    return result;
  };

  const call = <R>(method: HttpMethod, url: string, body: unknown, config?: RequestConfig<R>): Promise<IRes<R>> => {
    const request: PluginRequest = { method, url, body, config: config as RequestConfig<unknown> | undefined };
    const run = plugins.length ? sendThrough(plugins, request, (r) => dispatch(impl, r)) : dispatch(impl, request);
    return guard(() => run as Promise<IRes<R>>, config);
  };

  const client: ApiClient = {
    get: (url, config) => call("GET", url, undefined, config),
    post: (url, body, config) => call("POST", url, body, config),
    put: (url, body, config) => call("PUT", url, body, config),
    patch: (url, body, config) => call("PATCH", url, body, config),
    delete: (url, config) => call("DELETE", url, undefined, config),
    login: (body, config) => guard(() => impl.login(body, config), config),
    logout: (config) => impl.logout(config),
    setTokens: (tokens) => impl.setTokens(tokens),
    refresh: () => impl.refresh(),
    getSocketToken: (url, options) => requestSocketToken(client, url, options),
    getAccessToken: () => impl.getAccessToken(),
    getAuthState: () => impl.getAuthState(),
    restoreSession: (url) => impl.restoreSession(url),
    onAuthStateChange: (listener) => impl.onAuthStateChange(listener),
    cancel: (selector, reason) => impl.cancel(selector, reason),
    pending: (selector) => impl.pending(selector),
    cancelScope: (name) => createScope(client, name),
    // A getter: a worker blocked at boot falls back to the page after creation.
    get isWorker() {
      return impl.usesWorker ?? false;
    },
    destroy: () => impl.destroy(),
  } as ApiClient;

  return client;
}

/** Runs the ticket request through the public client, so it behaves like any other call. */
async function requestSocketToken(client: ApiClient, url: string, options: SocketTokenOptions = {}): Promise<string> {
  const { method = "POST", ...config } = options;
  const strict = { ...config, throwError: true, throwOnCancel: true };
  const res = method === "GET" ? await client.get(url, strict) : await client.post(url, undefined, strict);
  const token = extractSocketToken(res.data);
  if (token) return token;
  throw new ApiError({
    ...res,
    status: false,
    message: `No socket token in the response from ${url}: expected a string, or { token | ticket | socketToken }.`,
  });
}

/** Counter behind auto-generated scope names, so anonymous scopes stay distinct. */
let scopeSeq = 0;

/**
 * Builds a cancellation scope over a client.
 *
 * Every request gains the scope's group tag and, for reads, `cancelable: true`
 * — creating a scope is the opt-in, so it works even on a client that never
 * enabled `cancel`. A caller-supplied `cancelable` or extra `cancelGroup`
 * entries are preserved.
 */
function createScope(client: ApiClient, name?: string): CancelScope {
  const group = name ?? `scope-${++scopeSeq}`;

  const tag = <R>(config?: RequestConfig<R>): RequestConfig<R> => {
    const existing = config?.cancelGroup;
    const groups = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), group]
      : [group];

    return { ...config, cancelGroup: groups, cancelable: config?.cancelable ?? true };
  };

  /*
   * Writes stay opt-in even inside a scope: the server may already have
   * committed one, and a scope tears down on navigation — exactly when you
   * least want a half-applied write silently abandoned.
   */
  const tagWrite = <R>(config?: RequestConfig<R>): RequestConfig<R> => {
    const existing = config?.cancelGroup;
    const groups = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), group]
      : [group];

    return { ...config, cancelGroup: groups };
  };

  return {
    name: group,
    get: (url, config) => client.get(url, tag(config)),
    post: (url, body, config) => client.post(url, body, tagWrite(config)),
    put: (url, body, config) => client.put(url, body, tagWrite(config)),
    patch: (url, body, config) => client.patch(url, body, tagWrite(config)),
    delete: (url, config) => client.delete(url, tagWrite(config)),
    cancel: (reason) => client.cancel({ group }, reason ?? `scope "${group}" canceled`),
    pending: () => client.pending({ group }),
  } as CancelScope;
}
