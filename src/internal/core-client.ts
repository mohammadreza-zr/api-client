import type {
  AuthState,
  ClientOptions,
  HttpMethod,
  IRes,
  RequestConfig,
  TokenPair,
} from "../types";
import { AuthStore } from "./auth-store";
import { TabSync } from "./broadcast";
import { executeRequest, type EngineContext } from "./engine";
import { defaultExtractTokens, extractUser } from "./extract";
import { detectBaseUrl } from "./env";
import { resolveStorage } from "./storage";
import { joinUrl } from "./url";

/** Reads a single cookie value by name. */
function readCookie(name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

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
  private extractTokens: NonNullable<ClientOptions["extractTokens"]>;
  private buildRefreshBody: NonNullable<ClientOptions["buildRefreshBody"]>;
  private xsrfCookieName?: string;
  private xsrfHeaderName: string;
  private csrfProvider?: () => string | undefined;
  private hooks: Pick<ClientOptions, "onAuthStateChanged" | "onAuthFailure" | "onError" | "onLog">;
  private hydrated: Promise<void>;
  private disposed = false;

  constructor(options: ClientOptions = {}) {
    const authMode = options.authMode ?? "header";

    this.opts = {
      baseUrl: (options.baseUrl ?? detectBaseUrl()).replace(/\/+$/, ""),
      timeout: options.timeout ?? 30_000,
      authMode,
      credentials: options.credentials ?? (authMode === "cookie" ? "include" : "same-origin"),
      loginUrl: options.loginUrl ?? "/auth/login",
      refreshUrl: options.refreshUrl ?? "/auth/refresh",
      logoutUrl: options.logoutUrl ?? "/auth/logout",
      refreshSkewMs: options.refreshSkewMs ?? 30_000,
    };

    this.defaultHeaders = { "Content-Type": "application/json", ...options.headers };
    this.xsrfCookieName = options.xsrfCookieName;
    this.xsrfHeaderName = options.xsrfHeaderName ?? "X-CSRF-Token";
    this.csrfProvider = options.getCsrfToken;
    this.extractTokens = options.extractTokens ?? defaultExtractTokens;
    this.buildRefreshBody = options.buildRefreshBody ?? ((refresh) => (refresh ? { refresh } : {}));
    this.hooks = {
      onAuthStateChanged: options.onAuthStateChanged,
      onAuthFailure: options.onAuthFailure,
      onError: options.onError,
      onLog: options.onLog,
    };

    const storageKey = options.storageKey ?? "apiclient";
    // Cookie mode keeps tokens server-side; nothing to persist locally.
    const storage = authMode === "cookie" ? undefined : resolveStorage(options.storage ?? "memory", storageKey);

    this.auth = new AuthStore(storage);
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
      // Another tab rotated the tokens. In cookie mode the browser already has
      // the new cookie; in header mode we re-read the shared storage.
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
      getCsrfToken: () => this.readCsrfToken(),
      csrfHeaderName: this.xsrfHeaderName,
      onLog: this.hooks.onLog,
    };
  }

  /**
   * Resolves the CSRF token.
   *
   * An explicit provider wins, since `document.cookie` does not exist inside a
   * Web Worker or on the server — that is exactly when `getCsrfToken` is needed.
   */
  private readCsrfToken(): string | undefined {
    if (this.csrfProvider) {
      try {
        return this.csrfProvider();
      } catch {
        return undefined;
      }
    }
    if (!this.xsrfCookieName || typeof document === "undefined") return undefined;
    return readCookie(this.xsrfCookieName);
  }

  /**
   * Refreshes the access token.
   * Concurrent callers share one network call; other tabs are told the result.
   */
  async refresh(): Promise<string | null> {
    return this.auth.coalesceRefresh(async () => {
      // Let whichever tab claimed leadership drive; others still await their
      // own call, which is harmless and keeps them correct if the leader dies.
      this.tabs.claimLeadership();

      const url = joinUrl(this.opts.baseUrl, this.opts.refreshUrl);
      const body = this.buildRefreshBody(this.auth.refreshToken);

      // Header mode with no refresh token cannot possibly succeed.
      if (this.opts.authMode === "header" && !this.auth.refreshToken) {
        this.failAuth();
        return null;
      }

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...this.defaultHeaders },
          credentials: this.opts.credentials,
          body: body === undefined ? undefined : JSON.stringify(body),
        });

        if (!response.ok) {
          this.failAuth();
          return null;
        }

        const payload = await response.json().catch(() => undefined);
        const tokens = this.extractTokens(payload);

        if (tokens?.accessToken || tokens?.refreshToken) {
          this.auth.apply(tokens);
        } else if (this.opts.authMode === "cookie") {
          // Server rotated httpOnly cookies and returned no body.
          this.auth.apply({ expiresAt: undefined });
        } else {
          this.failAuth();
          return null;
        }

        this.tabs.post({ type: "refreshed", tabId: this.tabs.tabId, expiresAt: this.auth.expiresAt });
        return this.auth.accessToken ?? "";
      } catch {
        this.failAuth();
        return null;
      }
    });
  }

  private failAuth(): void {
    this.auth.clear();
    this.tabs.post({ type: "logout", tabId: this.tabs.tabId });
    this.hooks.onAuthFailure?.();
  }

  // ── requests ───────────────────────────────────────────

  private async send<R>(
    method: HttpMethod,
    url: string,
    body?: unknown,
    config?: RequestConfig<R>,
  ): Promise<IRes<R>> {
    await this.hydrated;

    const result = await executeRequest<R>(
      { method, url, body, config: config as RequestConfig<unknown> },
      this.context(),
    );

    if (!result.status && !config?.hideErrorMessage) {
      this.hooks.onError?.(result);
    }

    return result;
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
      ...config,
      skipAuth: true,
      refreshTokenCheck: false,
      fullData: true,
    } as RequestConfig<R>);

    if (result.status) {
      const tokens = this.extractTokens(result.data);
      if (tokens) this.auth.apply(tokens);
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
    this.auth.apply(tokens);
    // Await durability: callers seed tokens then often navigate immediately.
    await this.auth.flush();
    this.tabs.post({ type: "login", tabId: this.tabs.tabId, expiresAt: this.auth.expiresAt });
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
    this.tabs.destroy();
  }
}
