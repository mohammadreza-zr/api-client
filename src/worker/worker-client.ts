import type {
  WorkerRequest,
  WorkerResponse,
  FetchResultMessage,
  AuthStateChangedMessage,
  AuthResultMessage,
} from "./protocol";
import type { IRes } from "../types";
import { MultiTabCoordinator } from "./multi-tab";

export interface WorkerClientOptions {
  /** URL or path to the compiled worker script. */
  workerUrl: string | URL;

  baseUrl: string;
  timeout?: number;
  authMode?: "header" | "cookie";
  credentials?: RequestCredentials;
  defaultHeaders?: Record<string, string>;
  refreshUrl?: string;

  /** Initial tokens (sent once to worker, then forgotten by main thread). */
  initialAccessToken?: string;
  initialRefreshToken?: string;

  /** Called when auth state changes (no tokens, just booleans). */
  onAuthStateChanged?: (state: {
    isAuthenticated: boolean;
    expiresAt: number | null;
    user?: unknown;
  }) => void;
}

/**
 * Main-thread proxy to the isolated API worker.
 *
 * - Tokens are NEVER stored here.
 * - postMessage payloads never include tokens.
 * - All fetch calls happen inside the worker.
 */
export class WorkerClient {
  private worker: Worker;
  private pending = new Map<string, {
    resolve: (res: IRes<any>) => void;
    reject: (err: Error) => void;
  }>();
  private requestCounter = 0;
  private ready = false;
  private readyPromise: Promise<void>;
  private multiTab: MultiTabCoordinator;
  private onAuthStateChanged?: WorkerClientOptions["onAuthStateChanged"];

  constructor(options: WorkerClientOptions) {
    this.onAuthStateChanged = options.onAuthStateChanged;
    this.multiTab = new MultiTabCoordinator();

    this.worker = new Worker(options.workerUrl, { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      this.handleResponse(event.data);
    };
    this.worker.onerror = (err) => {
      console.error("[fetchguard:worker]", err.message);
    };

    // Wait for READY
    this.readyPromise = new Promise((resolve) => {
      const check = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.type === "READY") {
          this.ready = true;
          this.worker.removeEventListener("message", check);
          resolve();
        }
      };
      this.worker.addEventListener("message", check);
    });

    // Setup the worker
    const setup: WorkerRequest = {
      type: "SETUP",
      payload: {
        baseUrl: options.baseUrl,
        timeout: options.timeout ?? 30_000,
        authMode: options.authMode ?? "header",
        credentials: options.credentials ?? (options.authMode === "cookie" ? "include" : "same-origin"),
        defaultHeaders: options.defaultHeaders ?? { "Content-Type": "application/json" },
        refreshUrl: options.refreshUrl ?? "/auth/refresh",
        initialAccessToken: options.initialAccessToken,
        initialRefreshToken: options.initialRefreshToken,
      },
    };
    this.worker.postMessage(setup);

    // Multi-tab events
    this.multiTab.onEvent((event) => {
      if (event.type === "LOGOUT") {
        this.onAuthStateChanged?.({ isAuthenticated: false, expiresAt: null });
      }
      if (event.type === "REFRESH_COMPLETED") {
        this.onAuthStateChanged?.({ isAuthenticated: true, expiresAt: event.expiresAt });
      }
    });
  }

  private handleResponse(msg: WorkerResponse) {
    switch (msg.type) {
      case "FETCH_RESULT": {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          pending.resolve({
            statusCode: msg.payload.statusCode,
            status: msg.payload.status,
            message: msg.payload.message,
            data: msg.payload.data,
            errors: msg.payload.errors,
            loading: false,
          });
        }
        break;
      }

      case "AUTH_STATE_CHANGED": {
        this.onAuthStateChanged?.(msg.payload);
        break;
      }

      case "AUTH_RESULT": {
        // Resolve any pending auth calls
        const pending = this.pending.get("__auth__");
        if (pending) {
          this.pending.delete("__auth__");
          pending.resolve({
            statusCode: msg.payload.success ? 200 : 401,
            status: msg.payload.success,
            message: msg.payload.message,
            data: { user: msg.payload.user, expiresAt: msg.payload.expiresAt },
            loading: false,
          });
        }
        break;
      }

      case "ERROR": {
        if (msg.id) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            pending.reject(new Error(msg.payload.message));
          }
        }
        break;
      }
    }
  }

  private async ensureReady(): Promise<void> {
    if (!this.ready) await this.readyPromise;
  }

  // ── Public API (mirrors APIClient) ───────────────────────

  async get<R = any>(url: string, config?: Record<string, unknown>): Promise<IRes<R>> {
    return this.fetch<R>("GET", url, undefined, config);
  }

  async post<R = any>(url: string, body?: unknown, config?: Record<string, unknown>): Promise<IRes<R>> {
    return this.fetch<R>("POST", url, body, config);
  }

  async put<R = any>(url: string, body?: unknown, config?: Record<string, unknown>): Promise<IRes<R>> {
    return this.fetch<R>("PUT", url, body, config);
  }

  async patch<R = any>(url: string, body?: unknown, config?: Record<string, unknown>): Promise<IRes<R>> {
    return this.fetch<R>("PATCH", url, body, config);
  }

  async delete<R = any>(url: string, config?: Record<string, unknown>): Promise<IRes<R>> {
    return this.fetch<R>("DELETE", url, undefined, config);
  }

  // ── Auth (no tokens returned to main thread) ─────────────

  async login(body: Record<string, unknown>, url?: string): Promise<IRes<any>> {
    await this.ensureReady();
    return new Promise((resolve, reject) => {
      this.pending.set("__auth__", { resolve, reject });
      const msg: WorkerRequest = {
        type: "AUTH_CALL",
        payload: { action: "login", body, url },
      };
      this.worker.postMessage(msg);
    });
  }

  async logout(url?: string): Promise<IRes<any>> {
    await this.ensureReady();
    return new Promise((resolve, reject) => {
      this.pending.set("__auth__", { resolve, reject });
      const msg: WorkerRequest = {
        type: "AUTH_CALL",
        payload: { action: "logout", url },
      };
      this.worker.postMessage(msg);
    });
  }

  /** Send tokens to worker once (e.g., from SSR or initial page load). */
  async setTokens(accessToken: string, refreshToken: string, expiresAt?: number): Promise<void> {
    await this.ensureReady();
    const msg: WorkerRequest = {
      type: "AUTH_CALL",
      payload: { action: "setTokens", accessToken, refreshToken, expiresAt },
    };
    this.worker.postMessage(msg);
    // After this call, main thread should discard its references
  }

  /** Cancel a pending request. */
  cancel(requestId: string) {
    const msg: WorkerRequest = { type: "CANCEL", id: requestId };
    this.worker.postMessage(msg);
  }

  /** Destroy the worker and clean up. */
  destroy() {
    this.multiTab.destroy();
    this.worker.terminate();
    this.pending.forEach((p) => p.reject(new Error("Worker destroyed")));
    this.pending.clear();
  }

  // ── Internal ─────────────────────────────────────────────

  private async fetch<R>(
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    url: string,
    body?: unknown,
    config?: Record<string, unknown>,
  ): Promise<IRes<R>> {
    await this.ensureReady();

    const id = `req_${++this.requestCounter}_${Date.now()}`;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      const msg: WorkerRequest = {
        type: "FETCH",
        id,
        payload: {
          method,
          url,
          body,
          headers: config?.headers as Record<string, string>,
          params: config?.params as Record<string, unknown>,
          addTemplateToUrl: config?.addTemplateToUrl as Record<string, string | number>,
          addToUrl: config?.addToUrl as (string | number)[],
          stringifyBody: config?.stringifyBody as boolean,
          isFormData: config?.isFormData as boolean,
          fullData: config?.fullData as boolean,
          refreshTokenCheck: config?.refreshTokenCheck as boolean,
          throwError: config?.throwError as boolean,
          log: config?.log as boolean,
        },
      };

      this.worker.postMessage(msg);
    });
  }
}