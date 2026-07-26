import type { IRes } from "./types";
import { APIClient } from "./client";
import { WorkerClient } from "./worker/worker-client";
import { getWorkerCode } from "./worker/worker-code";
import { isServer } from "./utils/helpers";
import type { MemoryTokenStorage } from "./storage/memory-storage";
import { MemoryTokenStorage as MemStorage } from "./storage/memory-storage";

export interface CreateClientOptions {
  /** API base URL. Falls back to env variables. */
  baseUrl?: string;

  /** Request timeout in ms. Default: 30000 */
  timeout?: number;

  /**
   * "header" → Authorization: Bearer <token>
   * "cookie" → httpOnly cookies sent by browser
   * Default: "header"
   */
  authMode?: "header" | "cookie";

  /**
   * Run fetch inside a Web Worker for maximum security.
   * Tokens are invisible to the main thread.
   *
   * Default: true (auto-disables in SSR / unsupported environments)
   */
  worker?: boolean;

  /**
   * Sync auth state across browser tabs via BroadcastChannel.
   * Default: true
   */
  multiTab?: boolean;

  /** Refresh endpoint path. Default: "/auth/refresh" */
  refreshUrl?: string;

  /** Called when auth permanently fails (refresh rejected). */
  onAuthFailure?: () => void;

  /** Called when auth state changes. Never includes tokens. */
  onAuthStateChanged?: (state: {
    isAuthenticated: boolean;
    expiresAt: number | null;
    user?: unknown;
  }) => void;

  /** Custom toast. */
  toast?: { error: (msg: string) => void };

  /** Custom headers for every request. */
  headers?: Record<string, string>;

  /**
   * Custom refresh handler (only used when worker: false).
   * If omitted in worker mode, the worker handles refresh internally.
   */
  refreshHandler?: (refreshToken: string | undefined) => Promise<string | null>;
}

/**
 * The unified client interface.
 * Same methods regardless of worker or main-thread mode.
 */
export interface FetchGuardClient {
  get<R = any>(url: string, config?: Record<string, any>): Promise<IRes<R>>;
  post<R = any>(url: string, body?: any, config?: Record<string, any>): Promise<IRes<R>>;
  put<R = any>(url: string, body?: any, config?: Record<string, any>): Promise<IRes<R>>;
  patch<R = any>(url: string, body?: any, config?: Record<string, any>): Promise<IRes<R>>;
  delete<R = any>(url: string, config?: Record<string, any>): Promise<IRes<R>>;

  /** Login. Tokens stored internally (worker closure or memory). Never returned. */
  login(body: Record<string, unknown>, url?: string): Promise<IRes<any>>;

  /** Logout. Clears tokens everywhere (all tabs). */
  logout(url?: string): Promise<IRes<any>>;

  /**
   * Manually set tokens (e.g., from SSR, OAuth callback, or initial load).
   * In worker mode, tokens are sent to the worker and immediately forgotten.
   */
  setTokens(accessToken: string, refreshToken: string, expiresAt?: number): Promise<void>;

  /** Destroy the client (terminate worker, close channels). */
  destroy(): void;
}

/**
 * Create an API client.
 *
 * ```typescript
 * import { createClient } from "fetchguard";
 *
 * const api = createClient({ baseUrl: "https://api.example.com" });
 *
 * const { data } = await api.get("/users/");
 * await api.login({ email: "a@b.com", password: "123" });
 * ```
 *
 * - Worker isolation: automatic (disabled in SSR)
 * - Multi-tab sync: automatic
 * - Token refresh: automatic
 * - Framework: any (React, Vue, Angular, Svelte, Next, Nuxt, Vite, etc.)
 */
export function createClient(options: CreateClientOptions = {}): FetchGuardClient {
  const useWorker = options.worker !== false && !isServer() && typeof Worker !== "undefined";

  if (useWorker) {
    return createWorkerClient(options);
  }

  return createMainThreadClient(options);
}

// ── Worker mode ──────────────────────────────────────────

function createWorkerClient(options: CreateClientOptions): FetchGuardClient {
  const workerCode = getWorkerCode();
  const blob = new Blob([workerCode], { type: "application/javascript" });
  const workerUrl = URL.createObjectURL(blob);

  const client = new WorkerClient({
    workerUrl,
    baseUrl: options.baseUrl ?? getBaseUrl(),
    timeout: options.timeout,
    authMode: options.authMode,
    credentials: options.authMode === "cookie" ? "include" : "same-origin",
    defaultHeaders: options.headers,
    refreshUrl: options.refreshUrl ?? "/auth/refresh",
    onAuthStateChanged: (state) => {
      options.onAuthStateChanged?.(state);
      if (!state.isAuthenticated && options.onAuthFailure) {
        options.onAuthFailure();
      }
    },
  });

  return {
    get: (url, config) => client.get(url, config),
    post: (url, body, config) => client.post(url, body, config),
    put: (url, body, config) => client.put(url, body, config),
    patch: (url, body, config) => client.patch(url, body, config),
    delete: (url, config) => client.delete(url, config),
    login: (body, url) => client.login(body, url),
    logout: (url) => client.logout(url),
    setTokens: (a, r, e) => client.setTokens(a, r, e),
    destroy: () => {
      client.destroy();
      URL.revokeObjectURL(workerUrl);
    },
  };
}

// ── Main-thread mode (SSR fallback) ─────────────────────

function createMainThreadClient(options: CreateClientOptions): FetchGuardClient {
  const storage = new MemStorage();

  const apiClient = new APIClient(
    {
      baseUrl: options.baseUrl ?? getBaseUrl(),
      timeout: options.timeout,
      authMode: options.authMode,
      headers: options.headers,
      toast: options.toast,
      onAuthFailure: options.onAuthFailure,
    },
    storage,
    options.refreshHandler ?? defaultRefreshHandler(options, storage),
    options.onAuthFailure,
  );

  return {
    get: (url, config) => apiClient.get(url, config),
    post: (url, body, config) => apiClient.post(url, body, config),
    put: (url, body, config) => apiClient.put(url, body, config),
    patch: (url, body, config) => apiClient.patch(url, body, config),
    delete: (url, config) => apiClient.delete(url, config),

    login: async (body, url) => {
      const loginUrl = url ?? `${options.baseUrl ?? getBaseUrl()}${options.refreshUrl?.replace("refresh", "login") ?? "/auth/login"}`;
      const res = await fetch(loginUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        const access = data.data?.access ?? data.access;
        const refresh = data.data?.refresh ?? data.refresh;
        await storage.setAccessToken(access);
        await storage.setRefreshToken(refresh);
        options.onAuthStateChanged?.({ isAuthenticated: true, expiresAt: Date.now() + 300_000, user: data.data?.user });
      }
      return {
        statusCode: res.status,
        status: res.ok,
        message: data.message ?? "",
        data: data.data,
        loading: false,
      };
    },

    logout: async (url) => {
      const logoutUrl = url ?? `${options.baseUrl ?? getBaseUrl()}/auth/logout`;
      const token = await storage.getAccessToken();
      try {
        await fetch(logoutUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
      } catch { /* ignore */ }
      await storage.clearTokens();
      options.onAuthStateChanged?.({ isAuthenticated: false, expiresAt: null });
      return { statusCode: 200, status: true, message: "Logged out", loading: false };
    },

    setTokens: async (access, refresh) => {
      await storage.setAccessToken(access);
      await storage.setRefreshToken(refresh);
    },

    destroy: () => { /* no-op for main thread */ },
  };
}

function defaultRefreshHandler(
  options: CreateClientOptions,
  storage: MemStorage,
) {
  return async (refreshToken: string | undefined): Promise<string | null> => {
    if (!refreshToken) return null;
    const base = options.baseUrl ?? getBaseUrl();
    const url = `${base}${options.refreshUrl ?? "/auth/refresh"}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: options.authMode === "cookie" ? "include" : "same-origin",
      body: JSON.stringify({ refresh: refreshToken }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const access = data.data?.access ?? data.access;
    const refresh = data.data?.refresh ?? data.refresh;
    if (access) await storage.setAccessToken(access);
    if (refresh) await storage.setRefreshToken(refresh);
    return access ?? null;
  };
}

function getBaseUrl(): string {
  if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_BASE_URL) {
    return process.env.NEXT_PUBLIC_BASE_URL;
  }
  try {
    const meta = (import.meta as any)?.env;
    if (meta?.VITE_BASE_URL) return meta.VITE_BASE_URL;
  } catch { /* CJS */ }
  return "";
}