import type {
  AuthState,
  CancelSelector,
  ClientOptions,
  HttpMethod,
  IRes,
  PendingRequest,
  RequestConfig,
  TokenExtractor,
  TokenPair,
  TokenStorage,
} from "../types";
import { AuthStore } from "./auth-store";
import { TabSync } from "./broadcast";
import { previewUrl, toPath } from "./cancel";
import { createCsrfReader, type CsrfReader } from "./cookie";
import { executeRequest, type EngineContext } from "./engine";
import { extractUser, normalizeExtractor, normalizeRefreshBody } from "./extract";
import { trustedOrigins } from "./origin";
import { runRefresh } from "./refresh";
import { sharesSession } from "./storage";
import { RequestTracker } from "./tracker";
import { joinUrl } from "./url";

/**
 * The full client implementation.
 *
 * Runs unchanged on the main thread, inside a Web Worker, and on the server —
 * so every execution mode has identical behaviour by construction.
 */
export class CoreClient {
  private auth: AuthStore;
  private tabs: TabSync;
  private opts: Required<
    Pick<
      ClientOptions,
      "baseUrl" | "timeout" | "authMode" | "credentials" | "loginUrl" | "refreshUrl" | "logoutUrl" | "refreshSkewMs"
    >
  >;
  private defaultHeaders: Record<string, string>;
  private extractTokens: TokenExtractor;
  private buildRefreshBody: (refresh?: string) => unknown;
  private xsrfHeaderName: string;
  private readCsrf: CsrfReader;
  private trusted: ReadonlySet<string>;
  private sharedSession: boolean;
  private siblingRefreshedAt = 0;
  private exposeTokens: boolean;
  private hooks: Pick<ClientOptions, "onAuthStateChanged" | "onAuthFailure" | "onError" | "onLog">;
  private hydrated: Promise<void>;
  private disposed = false;
  private tracker: RequestTracker;

  /**
   * `storage` is the adapter tokens persist through (`storageFor` on the main
   * thread, a host proxy in the worker); none means memory only. It is passed
   * in so the worker bundle never ships adapters it cannot use, while
   * `options.storage` still names the kind — whether tabs share the session
   * depends on what the host really stores into.
   */
  constructor(options: ClientOptions = {}, storage?: TokenStorage) {
    const authMode = options.authMode ?? "header";

    this.opts = {
      // Resolved by the caller (`resolveBaseUrl`), so env detection never ships in the worker bundle.
      baseUrl: (options.baseUrl ?? "").replace(/\/+$/, ""),
      timeout: options.timeout ?? 30_000,
      authMode,
      credentials: options.credentials ?? (authMode === "cookie" ? "include" : "same-origin"),
      loginUrl: options.loginUrl ?? "/auth/login",
      refreshUrl: options.refreshUrl ?? "/auth/refresh",
      logoutUrl: options.logoutUrl ?? "/auth/logout",
      refreshSkewMs: options.refreshSkewMs ?? 30_000,
    };

    this.defaultHeaders = { ...options.headers };
    this.tracker = new RequestTracker(options.cancel, this.opts.baseUrl);
    this.xsrfHeaderName = options.xsrfHeaderName ?? "X-CSRF-Token";
    this.readCsrf = createCsrfReader(options);
    this.trusted = trustedOrigins(this.opts.baseUrl, options.authOrigins);
    this.sharedSession = sharesSession(options);
    this.exposeTokens = options.exposeTokens === true;
    // Accepts both the function forms and the declarative (serializable)
    // TokenFieldMap / RefreshBodyConfig forms.
    this.extractTokens = normalizeExtractor(options.extractTokens);
    this.buildRefreshBody = normalizeRefreshBody(options.buildRefreshBody);
    this.hooks = options;

    const storageKey = options.storageKey ?? "apiclient";
    // Cookie mode keeps tokens server-side; nothing to persist locally.
    this.auth = new AuthStore(authMode === "cookie" ? undefined : storage);
    this.auth.subscribe((state) => this.hooks.onAuthStateChanged?.(state));

    this.tabs = new TabSync(`${storageKey}.auth`, options.multiTab !== false);
    this.tabs.on((msg) => this.onTabMessage(msg));

    this.hydrated = this.auth.hydrate();
  }

  // ── cross-tab ──────────────────────────────────────────

  private onTabMessage(msg: { type: string; expiresAt?: number | null }): void {
    if (this.disposed) return;

    if (msg.type === "logout") {
      this.auth.clear();
      this.hooks.onAuthFailure?.();
      return;
    }

    if (msg.type === "refreshed" || msg.type === "login") {
      this.siblingRefreshedAt = Date.now();
      /*
       * Cookie mode: there is no shared storage to re-read — `hydrate()` is a
       * no-op without an adapter — but the httpOnly cookie is origin-scoped,
       * so the browser has already given this tab the very same session. The
       * sibling's success is therefore proof that we are signed in too.
       */
      if (this.opts.authMode === "cookie") {
        this.auth.markSession(true);
        return;
      }

      // Header mode: another tab rotated the tokens into shared storage.
      void this.auth.hydrate().then(() => this.auth.emit());
    }
  }

  // ── engine wiring ──────────────────────────────────────

  private context(): EngineContext {
    return {
      baseUrl: this.opts.baseUrl,
      timeout: this.opts.timeout,
      defaultHeaders: this.defaultHeaders,
      credentials: this.opts.credentials,
      authMode: this.opts.authMode,
      trustedOrigins: this.trusted,
      getAccessToken: () => this.auth.accessToken,
      refresh: () => this.refresh(),
      shouldPreemptivelyRefresh: (skewMs?: number) => {
        // A per-request skew (long uploads) overrides the client default and
        // works even when the client-wide check is disabled.
        const window = skewMs ?? this.opts.refreshSkewMs;
        if (window <= 0) return false;
        if (this.opts.authMode === "cookie") return false;
        if (!this.auth.accessToken || !this.auth.refreshToken) return false;
        return this.auth.isExpired(window);
      },
      getCsrfToken: this.readCsrf,
      csrfHeaderName: this.xsrfHeaderName,
      onLog: this.hooks.onLog,
    };
  }

  /**
   * Refreshes the access token. Concurrent callers share one network call,
   * tabs take turns, and other tabs are told the result.
   *
   * Returns `true` on success, `false` on failure. Only a server rejection
   * ends the session; a network failure leaves it intact.
   */
  async refresh(): Promise<boolean> {
    return this.auth.coalesceRefresh(() =>
      runRefresh({
        auth: this.auth,
        tabs: this.tabs,
        url: joinUrl(this.opts.baseUrl, this.opts.refreshUrl),
        authMode: this.opts.authMode,
        credentials: this.opts.credentials,
        timeout: this.opts.timeout,
        defaultHeaders: this.defaultHeaders,
        sharedSession: this.sharedSession,
        extractTokens: this.extractTokens,
        buildRefreshBody: this.buildRefreshBody,
        readCsrf: this.readCsrf,
        csrfHeaderName: this.xsrfHeaderName,
        siblingRefreshedAt: () => this.siblingRefreshedAt,
        reject: () => this.failAuth(),
      }),
    );
  }

  private failAuth(): void {
    // A tab that never had a session, or doesn't share it, must not log the others out.
    const broadcast = this.sharedSession && this.auth.hasCredentials;
    this.auth.clear();
    if (broadcast) this.tabs.post({ type: "logout", tabId: this.tabs.tabId });
    this.hooks.onAuthFailure?.();
  }

  // ── requests ───────────────────────────────────────────

  /** The request pipeline behind every verb; also the worker host's in-page fallback. */
  async send<R>(
    method: HttpMethod,
    url: string,
    body?: unknown,
    config?: RequestConfig<R>,
  ): Promise<IRes<R>> {
    await this.hydrated;

    const request = config as RequestConfig<unknown> | undefined;
    // Tracked only when cancelable: a client that never opts in pays nothing.
    const tracked = this.tracker.track(method, url, request);

    let result: IRes<R>;
    try {
      result = await executeRequest<R>(
        { method, url, body, config: request, cancelSignal: tracked?.signal },
        this.context(),
      );
    } finally {
      tracked?.release();
    }

    /*
     * Cookie mode: infer the session from what the server actually does.
     *
     * The cookie is httpOnly, so on a fresh page load there is nothing to
     * read and no way to know whether a session exists until a request is
     * made.
     *
     * Only the *negative* direction is inferred here: a 401/403 that
     * survived the refresh-and-retry flow proves there is no session. A 2xx
     * proves nothing by itself — public endpoints return 200 to anonymous
     * visitors too — so marking the session active from any success would
     * report logged-out users as authenticated. The positive direction is
     * asserted explicitly, where the server's answer actually means it:
     * `login()`, a successful `refresh()`, and `restoreSession()` (the
     * caller names an endpoint that requires a session) all call
     * `markSession(true)` themselves.
     */
    if (this.opts.authMode === "cookie" && !config?.skipAuth) {
      // With the refresh flow on, a rejected refresh already ended the session and
      // a network blip must not; 403 means "not allowed", not "not signed in".
      if (result.statusCode === 401 && config?.refreshTokenCheck === false) {
        this.auth.markSession(false);
      }
    }

    /*
     * A cancellation is not an error the user should see. Firing `onError`
     * here would pop a toast every time someone changed page or closed a
     * modal, which is exactly what this feature exists to avoid.
     */
    if (!result.status && !result.canceled && !config?.hideErrorMessage) {
      this.hooks.onError?.(result);
    }

    return result;
  }

  // ── cancellation ───────────────────────────────────────

  /** Cancels matching in-flight requests. Returns how many were stopped. */
  cancel(selector?: CancelSelector, reason?: string): number {
    return this.tracker.cancel(selector, reason);
  }

  /** The cancelable requests currently in flight. */
  pending(selector?: CancelSelector): PendingRequest[] {
    return this.tracker.pending(selector);
  }

  /** Whether a canceled request should reject. Independent of `throwError`. */
  shouldThrowOnCancel(config?: RequestConfig<unknown>): boolean {
    return this.tracker.shouldThrowOnCancel(config);
  }

  get<R = unknown>(url: string, config?: RequestConfig<R>): Promise<IRes<R>> {
    return this.send<R>("GET", url, undefined, config);
  }
  post<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>> {
    return this.send<R>("POST", url, body, config);
  }
  put<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>> {
    return this.send<R>("PUT", url, body, config);
  }
  patch<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>> {
    return this.send<R>("PATCH", url, body, config);
  }
  delete<R = unknown>(url: string, config?: RequestConfig<R>): Promise<IRes<R>> {
    return this.send<R>("DELETE", url, undefined, config);
  }

  // ── auth actions ───────────────────────────────────────

  async login<R = unknown>(body: unknown, config?: RequestConfig<R>): Promise<IRes<R>> {
    const result = await this.send<R>("POST", this.opts.loginUrl, body, {
      // A caller can still opt in explicitly; the default is never to make an
      // auth handshake collateral damage of a route change.
      cancelable: false,
      ...config,
      skipAuth: true,
      refreshTokenCheck: false,
      fullData: true,
    } as RequestConfig<R>);

    if (result.status) {
      const tokens = this.extractTokens(result.data);
      if (tokens || this.opts.authMode === "cookie") this.auth.replace(tokens ?? {});
      /*
       * In cookie mode the tokens are httpOnly: the body carries no access
       * token and `document.cookie` cannot see one either. A 2xx from the
       * login endpoint is the only signal we get, so trust it and mark the
       * session active — otherwise `isAuthenticated` could never become true.
       */
      if (this.opts.authMode === "cookie") this.auth.markSession(true);
      const user = extractUser(result.data);
      if (user !== undefined) this.auth.setUser(user);
      // A successful login is usually followed by a redirect; make sure the
      // tokens are durable before we hand control back.
      await this.auth.flush();
      this.tabs.post({ type: "login", tabId: this.tabs.tabId, expiresAt: this.auth.expiresAt });

      // Honour the caller's unwrapping preference for the returned value.
      if (!config?.fullData) {
        const envelope = result.data as Record<string, unknown> | undefined;
        if (envelope && typeof envelope === "object" && envelope.data !== undefined) {
          result.body = envelope;
          result.data = envelope.data as R;
        }
      }
    }

    return result;
  }

  async logout<R = unknown>(config?: RequestConfig<R>): Promise<IRes<R>> {
    let result: IRes<R> = { statusCode: 200, status: true, message: "Logged out", loading: false };

    try {
      result = await this.send<R>("POST", this.opts.logoutUrl, this.buildRefreshBody(this.auth.refreshToken), {
        cancelable: false,
        ...config,
        refreshTokenCheck: false,
        hideErrorMessage: true,
      } as RequestConfig<R>);
    } catch {
      /* logging out locally matters more than the round trip */
    }

    this.auth.clear();
    // Likewise on the way out: the record must be gone before any redirect.
    await this.auth.flush();
    this.tabs.post({ type: "logout", tabId: this.tabs.tabId });
    return result;
  }

  async setTokens(tokens: TokenPair): Promise<void> {
    await this.hydrated;
    this.auth.seed(tokens);
    // Await durability: callers seed tokens then often navigate immediately.
    await this.auth.flush();
    this.tabs.post({ type: "login", tabId: this.tabs.tabId, expiresAt: this.auth.expiresAt });
  }

  /**
   * Determines whether a session already exists — the missing piece for
   * httpOnly cookie auth on a fresh page load.
   *
   * The cookie cannot be read from JS, so the only way to know is to ask the
   * server. Calls `url` when given, otherwise the refresh endpoint, and
   * records the outcome. Returns the resulting state.
   *
   * In header mode this just reports the rehydrated state without a request:
   * the stored token already answers the question.
   */
  async restoreSession(url?: string): Promise<AuthState> {
    await this.hydrated;

    if (this.opts.authMode !== "cookie") return this.auth.state;

    if (url) {
      // A probe endpoint (`/api/auth/me`) also gives us the user object.
      const probe = await this.send<unknown>("GET", url, undefined, {
        refreshTokenCheck: false,
        hideErrorMessage: true,
        /*
         * Never cancelable, even though it is a GET.
         *
         * This runs at app startup and establishes whether the user is signed
         * in. A blanket `api.cancel()` on the first route change would abort
         * it and leave the app believing there is no session.
         */
        cancelable: false,
      } as RequestConfig<unknown>);

      if (probe.status) {
        const user = extractUser(probe.data) ?? probe.data;
        if (user !== undefined) this.auth.setUser(user);
        /*
         * The caller explicitly asked "is there a session?" against an
         * endpoint they chose because it requires one — a 2xx from it is the
         * server's answer. This is the one place a plain success may assert
         * the session; ordinary requests never do (a public endpoint 200s
         * for anonymous visitors too).
         */
        this.auth.markSession(true);
      }
      return this.auth.state;
    }

    // No probe URL: a successful refresh proves the cookie is still valid.
    await this.refresh();
    return this.auth.state;
  }

  /** See `ApiClient.getAccessToken`. Enforced here, so in worker mode the worker itself refuses. */
  async getAccessToken(): Promise<string | undefined> {
    if (!this.exposeTokens) {
      throw new Error(
        "getAccessToken() needs createClient({ exposeTokens: true }). " +
          "If your socket server can issue its own ticket, use api.getSocketToken(url) instead.",
      );
    }
    await this.hydrated;
    if (this.opts.authMode === "cookie") return undefined;
    if (this.auth.refreshToken && this.auth.isExpired(this.opts.refreshSkewMs)) await this.refresh();
    return this.auth.isExpired() ? undefined : this.auth.accessToken;
  }

  /** For the worker boundary: the session's tokens, which must never cross to the page. */
  liveTokens(): Set<string> {
    return new Set([this.auth.accessToken, this.auth.refreshToken].filter((t): t is string => Boolean(t)));
  }

  /** For the worker boundary: whether `url` is the login or refresh endpoint, which mint tokens. */
  isAuthEndpoint(url: string, config?: RequestConfig<unknown>): boolean {
    const path = toPath(previewUrl(url, this.opts.baseUrl, config));
    return [this.opts.loginUrl, this.opts.refreshUrl].some((u) => toPath(joinUrl(this.opts.baseUrl, u)) === path);
  }

  async getAuthState(): Promise<AuthState> {
    await this.hydrated;
    return this.auth.state;
  }

  onAuthStateChange(listener: (state: AuthState) => void): () => void {
    return this.auth.subscribe(listener);
  }

  destroy(): void {
    this.disposed = true;
    this.tracker.cancel(undefined, "client destroyed");
    this.tabs.destroy();
  }
}
