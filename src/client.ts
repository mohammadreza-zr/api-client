import type { APIConfig, HttpMethod, IRes } from "./types";
import type { APIClientOptions, AuthMode } from "./config/defaults";
import { DEFAULT_OPTIONS, DEFAULT_CONFIG } from "./config/defaults";
import { TokenManager } from "./core/token-manager";
import { executeFetch, type ExecutorDeps } from "./core/request-executor";
import { handleAuth } from "./interceptors/auth.interceptor";
import { handleError } from "./interceptors/error.interceptor";
import { MemoryTokenStorage } from "./storage/memory-storage";
import type { ITokenStorage } from "./storage/token-storage.interface";
import type { RefreshTokenHandler, LogoutHandler } from "./types";

export class APIClient {
  private baseURL: string;
  private defaultHeaders: Record<string, string>;
  private timeout: number;
  private tokenManager: TokenManager;
  private toast?: { error: (msg: string) => void };
  private authMode: AuthMode;
  private credentials: RequestCredentials;

  constructor(
    options: APIClientOptions = {},
    storage?: ITokenStorage,
    refreshHandler?: RefreshTokenHandler,
    onAuthFailure?: LogoutHandler,
  ) {
    this.baseURL = options.baseUrl ?? getEnvBaseUrl();

    this.defaultHeaders = {
      "Content-Type": "application/json",
      ...options.headers,
    };

    this.timeout = options.timeout ?? DEFAULT_OPTIONS.timeout;
    this.toast = options.toast;
    this.authMode = options.authMode ?? "header";

    // cookie mode → "include" by default so httpOnly cookies are sent cross-origin
    this.credentials =
      options.credentials ??
      (this.authMode === "cookie" ? "include" : "same-origin");

    this.tokenManager = new TokenManager({
      storage: storage ?? new MemoryTokenStorage(),
      refreshHandler,
      onAuthFailure: onAuthFailure ?? options.onAuthFailure,
    });
  }

  get tokens(): TokenManager {
    return this.tokenManager;
  }

  async setAccessToken(token: string): Promise<void> {
    await this.tokenManager.setAccessToken(token);
  }

  async setRefreshToken(token: string): Promise<void> {
    await this.tokenManager.setRefreshToken(token);
  }

  // ── HTTP verbs ───────────────────────────────────────────

  get<R = any>(url: string, config?: APIConfig<R>): Promise<IRes<R>> {
    return this.request<R>({ method: "GET", url, config });
  }

  post<R = any, B = any>(url: string, body: B, config?: APIConfig<R>): Promise<IRes<R>> {
    return this.request<R>({ method: "POST", url, body, config });
  }

  put<R = any, B = any>(url: string, body: B, config?: APIConfig<R>): Promise<IRes<R>> {
    return this.request<R>({ method: "PUT", url, body, config });
  }

  patch<R = any, B = any>(url: string, body: B, config?: APIConfig<R>): Promise<IRes<R>> {
    return this.request<R>({ method: "PATCH", url, body, config });
  }

  delete<R = any>(url: string, config?: APIConfig<R>): Promise<IRes<R>> {
    return this.request<R>({ method: "DELETE", url, config });
  }

  // ── core pipeline ────────────────────────────────────────

  private async request<R = any>(props: {
    method: HttpMethod;
    url: string;
    body?: any;
    config?: APIConfig<R>;
  }): Promise<IRes<R>> {
    const config: APIConfig<any> = { ...DEFAULT_CONFIG, ...props.config };

    const deps: ExecutorDeps = {
      baseURL: this.baseURL,
      defaultHeaders: this.defaultHeaders,
      timeout: this.timeout,
      getAccessToken: () => this.tokenManager.getAccessToken(),
      authMode: this.authMode,
      credentials: this.credentials,
    };

    const requestProps = {
      method: props.method,
      url: props.url,
      body: props.body,
      config,
    };

    let { result } = await executeFetch<R>(requestProps, deps);

    if (result.statusCode === 401 && config.refreshTokenCheck !== false) {
      result = await handleAuth<R>(result, requestProps, config, this.tokenManager, deps);
    }

    result = handleError<R>(result, config, { toast: this.toast });

    return result;
  }
}

// keep the import
import { getEnvBaseUrl } from "./utils/helpers";