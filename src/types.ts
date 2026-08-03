/**
 * Public type surface.
 * Everything a consumer can import is declared here.
 */

// ── HTTP ─────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** How credentials are attached to a request. */
export type AuthMode = "header" | "cookie";

/** Where tokens are kept between page loads (header mode only). */
export type StorageKind = "memory" | "local" | "session" | "cookie";

// ── Responses ────────────────────────────────────────────

/** Standardized response envelope returned by every call. Never throws by default. */
export interface IRes<R = unknown> {
  /** HTTP status code. `0` when the request never reached the network. */
  statusCode: number;
  /** `true` for 2xx. */
  status: boolean;
  /** Server message, or a human-readable failure reason. */
  message: string;
  /** Parsed payload. Unwrapped from `{ data: ... }` unless `fullData` is set. */
  data?: R;
  /** Always `false` on a settled response. Kept for UI-state ergonomics. */
  loading: boolean;
  /** Field-level validation errors, when the server sends them. */
  errors?: Record<string, string[]>;
  /** The underlying error, when one occurred. */
  error?: unknown;
  /** Response headers as a plain object (lowercased keys). */
  headers?: Record<string, string>;
  /**
   * `true` when the request was canceled — by `cancel()`, a `cancelScope`,
   * `takeLatest`, or your own `AbortSignal`. Always paired with
   * `statusCode: 0`, and never set for a timeout (`408`).
   *
   * A canceled request **resolves** by default, even under `throwError: true`,
   * so check this before using `data`:
   *
   * ```ts
   * const res = await api.get("/todos");
   * if (res.canceled) return;   // superseded or unmounted; not an error
   * setTodos(res.data);
   * ```
   */
  canceled?: boolean;
  /** The reason passed to `cancel()`, when one was given. */
  cancelReason?: string;
}

/** Common paginated list shape. */
export interface ListResponse<T = unknown> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/** Ordering helper for list endpoints. */
export type Ordering<T = unknown> = {
  [K in keyof T]?: "asc" | "desc";
};

/** Query-string parameters. Nested objects and arrays are supported. */
export interface Params<T = unknown> {
  ordering?: T extends ListResponse<infer R> ? Ordering<R> : Ordering<T>;
  [key: string]: unknown;
}

// ── Errors ───────────────────────────────────────────────

/** Thrown when `throwError` is enabled and a request fails. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly errors?: Record<string, string[]>;
  readonly data?: unknown;
  readonly response: IRes<unknown>;
  /**
   * `true` when the failure was a cancellation rather than a real error.
   *
   * ```ts
   * catch (e) {
   *   if (e instanceof ApiError && e.canceled) return;  // expected
   *   throw e;
   * }
   * ```
   */
  readonly canceled: boolean;
  /** The reason passed to `cancel()`, when one was given. */
  readonly cancelReason?: string;

  constructor(response: IRes<unknown>) {
    super(response.message || `Request failed with status ${response.statusCode}`);
    this.name = "ApiError";
    this.statusCode = response.statusCode;
    this.errors = response.errors;
    this.data = response.data;
    this.response = response;
    this.canceled = response.canceled === true;
    this.cancelReason = response.cancelReason;
  }
}

// ── Cancellation ─────────────────────────────────────────

/** A tracked in-flight request, as seen by `pending()` and predicate selectors. */
export interface PendingRequest {
  /** Monotonic id, unique per client. */
  id: number;
  method: HttpMethod;
  /** The fully resolved URL, query string included. */
  url: string;
  /** Just the path — no origin, no query, no hash. What patterns match against. */
  path: string;
  /** The `cancelKey` this request was sent with, when any. */
  key?: string;
  /** The `cancelGroup` tags this request was sent with. */
  groups: string[];
  /** Epoch ms when the request was registered. */
  startedAt: number;
}

/**
 * Selects which in-flight requests to cancel.
 *
 * | Selector | Cancels |
 * |---|---|
 * | *(omitted)* | everything in flight |
 * | `"/api/v1/products"` | a matching `cancelKey`, `cancelGroup`, or URL path prefix |
 * | `/\/products\/\d+/` | requests whose URL or path matches the regex |
 * | `{ url, method, key, group }` | requests matching **every** field given |
 * | `(req) => boolean` | whatever you decide |
 *
 * A bare string is intentionally forgiving — it tries the key, then the group,
 * then the URL pattern. Use the object form when you need to be exact.
 *
 * URL patterns are segment-aware and prefix-based:
 *
 * - `"/api/v1/products"` → `/api/v1/products`, `/api/v1/products/12`,
 *   `/api/v1/products/12/reviews` — but **not** `/api/v1/products-archive`
 * - `"/users/:id"` or `"/users/*"` → exactly one segment in that position
 * - `"/api/**\/images"` → zero or more segments in between
 * - `"/users$"` → exact: `/users` only, nothing below it
 */
export type CancelSelector =
  | string
  | RegExp
  | CancelMatch
  | ((request: PendingRequest) => boolean);

/** The explicit selector form. All supplied fields must match. */
export interface CancelMatch {
  /** URL pattern (see {@link CancelSelector}) or a regex. */
  url?: string | RegExp;
  /** Restrict to one or more HTTP methods. */
  method?: HttpMethod | HttpMethod[];
  /** Match a `cancelKey` exactly. */
  key?: string;
  /** Match one of the request's `cancelGroup` tags. */
  group?: string;
}

/**
 * Client-wide cancellation settings. Opt-in: cancellation is **off** unless
 * you enable it, and even then only `GET` is covered by default.
 *
 * ```ts
 * createClient({ cancel: true });                          // GETs are cancelable
 * createClient({ cancel: { methods: "all" } });            // everything is
 * createClient({ cancel: { takeLatest: true } });          // and auto-supersede
 * ```
 */
export interface CancelOptions {
  /**
   * Which methods become cancelable automatically. Default `["GET"]`.
   *
   * Reads are always safe to cancel. Writes are not — the server may already
   * have committed one — so `POST`/`PUT`/`PATCH`/`DELETE` stay opt-in unless
   * you widen this or set `cancelable: true` on the request.
   */
  methods?: HttpMethod[] | "all";

  /**
   * Whether a canceled request rejects with an `ApiError` (`canceled: true`).
   * **Default `false`** — it resolves with the envelope instead.
   *
   * Independent of `throwError` on purpose: a cancellation is something the
   * app asked for, not a failure. Rejecting makes TanStack Query treat it as
   * a retryable error and re-fire the request you just canceled, and turns
   * the ordinary `useEffect` async pattern into an unhandled rejection.
   *
   * Real failures still throw per `throwError`. Opt back in when you want a
   * cancellation to abort a surrounding `try` block:
   *
   * ```ts
   * createClient({ cancel: { throwOnCancel: true } });
   * ```
   */
  throwOnCancel?: boolean;

  /**
   * Auto-cancel the previous in-flight request that shares the same identity
   * (`cancelKey`, or `METHOD + path` when no key is given). Default `false`.
   *
   * Turns a stale-search race into a no-op: each keystroke supersedes the last.
   */
  takeLatest?: boolean;
}

/**
 * A cancellation scope: a thin wrapper around the client whose requests are
 * all tagged, so one `cancel()` stops the lot.
 *
 * Built for the "close the modal / leave the page" case:
 *
 * ```ts
 * const scope = api.cancelScope("product-modal");
 * await scope.get("/api/v1/products/12");
 * // on close
 * scope.cancel();
 * ```
 */
export interface CancelScope {
  /** The group tag applied to every request made through this scope. */
  readonly name: string;

  get<R = unknown>(url: string, config?: RequestConfig<R>): Promise<IRes<R>>;
  post<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
  put<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
  patch<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
  delete<R = unknown>(url: string, config?: RequestConfig<R>): Promise<IRes<R>>;

  /** Cancels everything started through this scope. Returns how many stopped. */
  cancel(reason?: string): number;

  /** The scope's in-flight requests. */
  pending(): PendingRequest[];
}

// ── Per-request config ───────────────────────────────────

/**
 * Per-request options. Native `RequestInit` fields (`cache`, `mode`,
 * `redirect`, `signal`, `keepalive`, …) are forwarded to `fetch`.
 */
export interface RequestConfig<T = unknown>
  extends Omit<RequestInit, "body" | "method" | "headers" | "credentials"> {
  /** Extra headers for this request. */
  headers?: Record<string, string>;

  /** Append path segments: `/users` + `["1","posts"]` → `/users/1/posts/` */
  addToUrl?: (string | number)[];

  /** Replace `{key}` placeholders: `/users/{id}` + `{ id: 7 }` → `/users/7` */
  addTemplateToUrl?: Record<string, string | number>;

  /** Query-string parameters. Nested objects and arrays supported. */
  params?: Params<T>;

  /** Override the base URL for this single request. */
  baseUrl?: string;

  /** Per-request timeout in ms. Falls back to the client default. */
  timeout?: number;

  /** Return the raw server payload instead of unwrapping `{ data }`. */
  fullData?: boolean;

  /** Run the 401 → refresh → retry flow. Default `true`. */
  refreshTokenCheck?: boolean;

  /** Send this request without an `Authorization` header. Default `false`. */
  skipAuth?: boolean;

  /** `JSON.stringify` the body. Default `true`. Ignored for FormData/Blob. */
  stringifyBody?: boolean;

  /** Treat the body as FormData (drops `Content-Type` so the runtime sets the boundary). */
  isFormData?: boolean;

  /** Suppress the `onError` callback for this request. */
  hideErrorMessage?: boolean;

  /**
   * Reject the promise on failure instead of resolving with `status: false`.
   * Overrides the client-wide setting for this one call.
   */
  throwError?: boolean;

  /**
   * Refresh the access token before sending when it expires within this many
   * ms. Use it for long uploads: a token with 40s left passes the normal
   * check, but a 5-minute upload will expire mid-flight.
   *
   * ```ts
   * // Refresh now if the token dies within 10 minutes.
   * await api.post("/upload", form, { uploadSkewMs: 600_000 });
   * ```
   */
  uploadSkewMs?: number;

  /**
   * `duplex` mode for streamed request bodies. Defaults to `"half"`, which is
   * required by spec whenever the body is a `ReadableStream`.
   */
  duplex?: "half";

  /** Emit a structured log line for this request. */
  log?: boolean;

  /**
   * Track this request so `cancel()` can stop it.
   *
   * Overrides the client-wide `cancel` setting in both directions — opt a
   * single write in, or opt one critical GET out.
   *
   * ```ts
   * await api.post("/draft", body, { cancelable: true });   // in
   * await api.get("/session", { cancelable: false });       // out
   * ```
   *
   * Implied by `cancelKey` and `takeLatest`.
   */
  cancelable?: boolean;

  /**
   * A stable identity for this request.
   *
   * Cancel it by name (`api.cancel("search")`), and — with `takeLatest` —
   * supersede the previous request that shares the key.
   */
  cancelKey?: string;

  /**
   * Tags for bulk cancellation: `api.cancel("checkout")` stops every request
   * tagged `"checkout"`. A request can carry several tags.
   *
   * Tagging alone does not make a write cancelable; pair it with
   * `cancelable: true` when you mean to cancel one.
   */
  cancelGroup?: string | string[];

  /**
   * Cancel the previous in-flight request with the same identity before
   * sending this one — the stale-search pattern, built in.
   *
   * Identity is `cancelKey` when given, otherwise `METHOD + path`.
   */
  takeLatest?: boolean;

  /**
   * Reject with an `ApiError` when canceled, instead of resolving with the
   * envelope. Defaults to the client's `cancel.throwOnCancel` (itself
   * `false`). Independent of `throwError`.
   */
  throwOnCancel?: boolean;

  /** Transform the body right before it is serialized. */
  beforeFunc?: (body: unknown) => unknown;

  /** Transform the payload after it is parsed. */
  afterFunc?: (data: T) => unknown;

  /** Transform the payload into select-option shapes. Runs before `afterFunc`. */
  beforeSelectOptions?: (data: T) => unknown;
}

// ── Auth ─────────────────────────────────────────────────

/** Auth state broadcast to the app. Never contains tokens. */
export interface AuthState {
  isAuthenticated: boolean;
  /** Epoch ms of access-token expiry, when known. */
  expiresAt: number | null;
  /** Whatever the login/refresh endpoint returned as `user`. */
  user?: unknown;
}

/** Shape of the tokens the client understands. */
export interface TokenPair {
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms. Derived from the JWT `exp` claim when omitted. */
  expiresAt?: number;
}

/** Maps a login/refresh response body onto tokens the client can use. */
export type TokenExtractor = (body: unknown) => TokenPair | null;

/**
 * Declarative token extraction — the worker-mode-friendly alternative to a
 * custom `extractTokens` function.
 *
 * A function cannot be structured-cloned into the request worker, so the
 * function form silently disables worker isolation. This plain-data map is
 * serializable, so the same custom shapes keep worker mode on:
 *
 * ```ts
 * createClient({
 *   // body: { result: { jwt: "…", renew: "…", expires_in: 900 } }
 *   extractTokens: {
 *     accessKeys: ["jwt"],
 *     refreshKeys: ["renew"],
 *     expiresInKeys: ["expires_in"],
 *     roots: ["result"],
 *   },
 * });
 * ```
 */
export interface TokenFieldMap {
  /** Key names for the access token, in priority order. Defaults: `access`, `accessToken`, `access_token`, `token`, `jwt`, `idToken`, `id_token`. */
  accessKeys?: string[];
  /** Key names for the refresh token, in priority order. Defaults: `refresh`, `refreshToken`, `refresh_token`. */
  refreshKeys?: string[];
  /** Key names for an absolute expiry timestamp (epoch seconds or milliseconds). Defaults: `expiresAt`, `expires_at`, `expiry`. */
  expiryKeys?: string[];
  /** Key names for an expiry given as a duration in seconds. Defaults: `expiresIn`, `expires_in`. */
  expiresInKeys?: string[];
  /** Top-level keys whose object value is searched for the above. Defaults: `data`, `tokens`, `result`, `payload`. */
  roots?: string[];
}

/**
 * Declarative refresh-request body — the worker-mode-friendly alternative to
 * a custom `buildRefreshBody` function. Plain data, so worker mode stays on:
 *
 * ```ts
 * createClient({ buildRefreshBody: { field: "refresh_token" } });
 * // → { "refresh_token": "<token>" }
 * ```
 */
export interface RefreshBodyConfig {
  /** JSON field the refresh token is sent under. Default `"refresh"`. */
  field?: string;
}

// ── Storage ──────────────────────────────────────────────

/** Pluggable token persistence. Implement to back tokens with anything. */
export interface TokenStorage {
  get(): Promise<TokenPair | null> | TokenPair | null;
  set(tokens: TokenPair): Promise<void> | void;
  clear(): Promise<void> | void;
}

// ── Logging ──────────────────────────────────────────────

export interface LogEntry {
  url: string;
  method: HttpMethod;
  statusCode: number;
  status: boolean;
  message: string;
  durationMs: number;
  timestamp: string;
  error?: unknown;
}

// ── Client options ───────────────────────────────────────

export interface ClientOptions {
  /**
   * API base URL. Falls back to `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_BASE_URL`,
   * `VITE_API_URL`, `VITE_BASE_URL`, `NUXT_PUBLIC_API_URL`, or `API_URL`.
   */
  baseUrl?: string;

  /** Default request timeout in ms. Default `30000`. */
  timeout?: number;

  /**
   * Reject with an `ApiError` on failure instead of resolving with
   * `status: false`. **Default `true`.**
   *
   * Throwing is the default because it is what every data-fetching library
   * expects: TanStack Query, SWR and Vue Query all detect failure through a
   * rejected promise. With `false` a 500 would be delivered as a *successful*
   * result and cached as data.
   *
   * Set `false` for the never-throwing envelope style, either globally or per
   * request:
   *
   * ```ts
   * const api = createClient({ throwError: false });   // envelope everywhere
   * await api.get("/x", { throwError: false });        // envelope for one call
   * ```
   */
  throwError?: boolean;

  /**
   * Opt in to cancellation. **Off by default** — nothing is tracked and there
   * is no bookkeeping cost until you ask for it.
   *
   * Once enabled, requests are registered while in flight and `api.cancel()`
   * can stop them by URL pattern, key, group or predicate. Only `GET` is
   * covered unless you widen `methods`: cancelling a read is always safe,
   * whereas a canceled write may already have been committed by the server.
   *
   * ```ts
   * const api = createClient({ cancel: true });
   *
   * // React Router / Next.js — drop everything the old page started
   * router.events.on("routeChangeStart", () => api.cancel());
   *
   * // Close a modal — drop just its requests
   * api.cancel("/api/v1/products");
   * ```
   *
   * Per-request `cancelable` always wins, so a single call can opt in or out
   * regardless of this setting.
   */
  cancel?: boolean | CancelOptions;

  /**
   * Name of the cookie holding the CSRF token. When set, the client reads it
   * and mirrors it into `xsrfHeaderName` on POST/PUT/PATCH/DELETE — the
   * standard double-submit pattern.
   *
   * Your backend still has to compare the cookie against the header and reject
   * mismatches; this only automates the client half.
   *
   * ```ts
   * createClient({ authMode: "cookie", xsrfCookieName: "csrftoken" });
   * ```
   */
  xsrfCookieName?: string;

  /** Header the CSRF token is sent under. Default `"X-CSRF-Token"`. */
  xsrfHeaderName?: string;

  /**
   * Supplies the CSRF token directly, for when it does not live in a readable
   * cookie (a `<meta>` tag, an API call, or inside a Web Worker where
   * `document.cookie` does not exist). Takes precedence over
   * `xsrfCookieName`.
   */
  getCsrfToken?: () => string | undefined;

  /** Headers merged into every request. */
  headers?: Record<string, string>;

  /**
   * `"header"` → `Authorization: Bearer <token>` (default).
   * `"cookie"` → the browser sends httpOnly cookies; no header is set and
   * `credentials: "include"` is used so it works cross-origin.
   */
  authMode?: AuthMode;

  /** Override the `credentials` mode. Defaults per `authMode`. */
  credentials?: RequestCredentials;

  /**
   * Run every request inside a Web Worker so tokens never touch the main
   * thread. Automatically disabled on the server or where Worker is missing.
   * Default `true`.
   */
  worker?: boolean;

  /** Keep auth state in sync across tabs via BroadcastChannel. Default `true`. */
  multiTab?: boolean;

  /**
   * Where to persist tokens in header mode. Default `"memory"`.
   * `"memory"` is the safest (nothing survives a reload, nothing readable by XSS).
   */
  storage?: StorageKind | TokenStorage;

  /** Prefix for persisted storage keys. Default `"apiclient"`. */
  storageKey?: string;

  /** Login endpoint path. Default `"/auth/login"`. */
  loginUrl?: string;
  /** Refresh endpoint path. Default `"/auth/refresh"`. */
  refreshUrl?: string;
  /** Logout endpoint path. Default `"/auth/logout"`. */
  logoutUrl?: string;

  /**
   * Refresh the access token this many ms before it expires, without waiting
   * for a 401. Set `0` to disable. Default `30000`.
   */
  refreshSkewMs?: number;

  /**
   * Pull tokens out of a login/refresh response body.
   *
   * Pass a function for arbitrary shapes, or a {@link TokenFieldMap} for the
   * common custom-key/custom-nesting cases. **Worker mode caveat:** a
   * function cannot be structured-cloned into the request worker, so the
   * function form disables worker isolation; the declarative map keeps it.
   *
   * Defaults to a forgiving extractor that understands `access`/`refresh`,
   * `access_token`/`refresh_token`, `accessToken`/`refreshToken`, and the
   * same keys nested under `data`, `tokens`, `result` or `payload`.
   */
  extractTokens?: TokenExtractor | TokenFieldMap;

  /**
   * Build the refresh request body. Default `{ refresh: <refreshToken> }`.
   *
   * Pass a function for arbitrary shapes, or a {@link RefreshBodyConfig} for
   * the common "send it under a different field" case. **Worker mode
   * caveat:** a function cannot be structured-cloned into the request
   * worker, so the function form disables worker isolation; the declarative
   * config keeps it.
   */
  buildRefreshBody?: ((refreshToken?: string) => unknown) | RefreshBodyConfig;

  /** Called whenever auth state changes. Never receives tokens. */
  onAuthStateChanged?: (state: AuthState) => void;

  /**
   * Called when auth is permanently lost — the server rejected a refresh,
   * or a logout (local or in another tab) happened.
   * Not called for network failures during a refresh: a blip is not a logout.
   */
  onAuthFailure?: () => void;

  /** Called for every failed request unless `hideErrorMessage` is set. */
  onError?: (error: IRes<unknown>) => void;

  /** Receives log entries when a request sets `log: true`. Default `console.info`. */
  onLog?: (entry: LogEntry) => void;
}
