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

  constructor(response: IRes<unknown>) {
    super(response.message || `Request failed with status ${response.statusCode}`);
    this.name = "ApiError";
    this.statusCode = response.statusCode;
    this.errors = response.errors;
    this.data = response.data;
    this.response = response;
  }
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
   * Defaults to a forgiving extractor that understands `access`/`refresh`,
   * `access_token`/`refresh_token`, `accessToken`/`refreshToken`,
   * and the same keys nested under `data`.
   */
  extractTokens?: TokenExtractor;

  /** Build the refresh request body. Default `{ refresh: <refreshToken> }`. */
  buildRefreshBody?: (refreshToken?: string) => unknown;

  /** Called whenever auth state changes. Never receives tokens. */
  onAuthStateChanged?: (state: AuthState) => void;

  /** Called when auth is permanently lost (refresh rejected, logout). */
  onAuthFailure?: () => void;

  /** Called for every failed request unless `hideErrorMessage` is set. */
  onError?: (error: IRes<unknown>) => void;

  /** Receives log entries when a request sets `log: true`. Default `console.info`. */
  onLog?: (entry: LogEntry) => void;
}
