/// <reference lib="webworker" />

import type {
  WorkerRequest,
  WorkerResponse,
  FetchMessage,
  TabBroadcast,
} from "./protocol";

;(function () {
  // ── Closure-isolated state ───────────────────────────────
  // These variables are NOT on `self`, NOT exported, NOT postable.
  // No API surface exists to retrieve them.

  let accessToken: string | null = null;
  let refreshToken: string | null = null;
  let expiresAt: number | null = null;
  let currentUser: unknown | undefined;

  let baseUrl = "";
  let timeout = 30_000;
  let authMode: "header" | "cookie" = "header";
  let credentials: RequestCredentials = "same-origin";
  let defaultHeaders: Record<string, string> = { "Content-Type": "application/json" };
  let refreshUrl = "/auth/refresh";

  let isRefreshing = false;
  let refreshSubscribers: Array<(token: string | null) => void> = [];

  const tabId = Math.random().toString(36).slice(2);
  let channel: BroadcastChannel | null = null;

  const controllers = new Map<string, AbortController>();

  // ── Multi-tab coordination ───────────────────────────────

  function initBroadcast() {
    if (typeof BroadcastChannel === "undefined") return;
    channel = new BroadcastChannel("fetchguard_auth");
    channel.onmessage = (event: MessageEvent<TabBroadcast>) => {
      const msg = event.data;
      if (msg.tabId === tabId) return; // ignore own messages

      switch (msg.type) {
        case "REFRESH_COMPLETED":
          // Another tab refreshed successfully.
          // Our next fetch will use the new cookie (httpOnly)
          // or we need to re-fetch our token from IndexedDB.
          expiresAt = msg.expiresAt;
          broadcastAuthState();
          break;

        case "LOGOUT":
          accessToken = null;
          refreshToken = null;
          expiresAt = null;
          currentUser = undefined;
          broadcastAuthState();
          break;

        case "AUTH_STATE_SYNC":
          expiresAt = msg.expiresAt;
          broadcastAuthState();
          break;
      }
    };
  }

  function broadcast(msg: TabBroadcast) {
    channel?.postMessage(msg);
  }

  function broadcastAuthState() {
    const response: WorkerResponse = {
      type: "AUTH_STATE_CHANGED",
      payload: {
        isAuthenticated: !!accessToken && !!expiresAt && expiresAt > Date.now(),
        expiresAt,
        user: currentUser,
      },
    };
    self.postMessage(response);
  }

  // ── Token refresh (concurrency-safe) ─────────────────────

  async function doRefresh(): Promise<string | null> {
    if (isRefreshing) {
      // Wait for the in-flight refresh
      return new Promise((resolve) => {
        refreshSubscribers.push(resolve);
      });
    }

    isRefreshing = true;
    broadcast({ type: "REFRESH_STARTED", tabId });

    try {
      const body: Record<string, unknown> = {};
      if (authMode === "header" && refreshToken) {
        body.refresh = refreshToken;
      }

      const res = await fetch(`${baseUrl}${refreshUrl}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials,
        body: Object.keys(body).length ? JSON.stringify(body) : undefined,
      });

      if (!res.ok) {
        // Refresh failed
        accessToken = null;
        refreshToken = null;
        expiresAt = null;
        currentUser = undefined;

        refreshSubscribers.forEach((cb) => cb(null));
        refreshSubscribers = [];
        isRefreshing = false;

        broadcast({ type: "LOGOUT", tabId });
        broadcastAuthState();
        return null;
      }

      const data = await res.json();

      // Store new tokens IN CLOSURE ONLY
      if (data.data?.access || data.access) {
        accessToken = data.data?.access ?? data.access;
      }
      if (data.data?.refresh || data.refresh) {
        refreshToken = data.data?.refresh ?? data.refresh;
      }

      // Parse expiry from JWT (or default 5 min)
      expiresAt = parseExpiry(accessToken) ?? Date.now() + 300_000;

      // Notify all waiting requests
      refreshSubscribers.forEach((cb) => cb(accessToken));
      refreshSubscribers = [];
      isRefreshing = false;

      broadcast({ type: "REFRESH_COMPLETED", tabId, expiresAt: expiresAt!, isAuthenticated: true });
      broadcastAuthState();

      return accessToken;
    } catch {
      refreshSubscribers.forEach((cb) => cb(null));
      refreshSubscribers = [];
      isRefreshing = false;

      broadcast({ type: "LOGOUT", tabId });
      broadcastAuthState();
      return null;
    }
  }

  function parseExpiry(token: string | null): number | null {
    if (!token) return null;
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      return payload.exp ? payload.exp * 1000 : null;
    } catch {
      return null;
    }
  }

  // ── Fetch executor (inside worker) ───────────────────────

  async function executeRequest(msg: FetchMessage): Promise<void> {
    const { id, payload } = msg;
    const controller = new AbortController();
    controllers.set(id, controller);

    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      let url = payload.url;

      // Template replacement
      if (payload.addTemplateToUrl) {
        for (const [key, val] of Object.entries(payload.addTemplateToUrl)) {
          url = url.replace(new RegExp(`\\{${key}\\}`, "g"), String(val));
        }
      }

      // Path segments
      if (payload.addToUrl?.length) {
        url = `${url.replace(/\/$/, "")}/${payload.addToUrl.join("/")}/`;
      }

      // Query string (simple — no qs in worker to keep it lean)
      if (payload.params && Object.keys(payload.params).length) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(payload.params)) {
          if (v != null && v !== "") qs.set(k, String(v));
        }
        const str = qs.toString();
        if (str) url += `?${str}`;
      }

      const fullUrl = `${baseUrl}${url}`;

      // Headers
      const headers: Record<string, string> = {
        ...defaultHeaders,
        ...(payload.headers ?? {}),
      };

      if (authMode === "header" && accessToken) {
        headers["Authorization"] = `Bearer ${accessToken}`;
      }

      if (payload.isFormData) {
        delete headers["Content-Type"];
      }

      // Body
      let body: BodyInit | undefined;
      if (payload.body != null) {
        body = payload.stringifyBody !== false
          ? JSON.stringify(payload.body)
          : (payload.body as BodyInit);
      }

      let response = await fetch(fullUrl, {
        method: payload.method,
        headers,
        body,
        signal: controller.signal,
        credentials,
      });

      // ── 401 → refresh → retry ──
      if (response.status === 401 && payload.refreshTokenCheck !== false) {
        const newToken = await doRefresh();

        if (newToken) {
          // Retry with new token
          if (authMode === "header") {
            headers["Authorization"] = `Bearer ${newToken}`;
          }

          response = await fetch(fullUrl, {
            method: payload.method,
            headers,
            body,
            credentials,
          });
        }
      }

      clearTimeout(timer);
      controllers.delete(id);

      // Parse response
      const data = response.status === 204
        ? undefined
        : await response.json().catch(() => undefined);

      let resultData = data;
      if (!payload.fullData && data?.data !== undefined) {
        resultData = data.data;
      }

      const result: WorkerResponse = {
        type: "FETCH_RESULT",
        id,
        payload: {
          statusCode: response.status,
          status: response.ok,
          message: data?.message ?? "",
          data: resultData,
          errors: data?.errors,
        },
      };

      self.postMessage(result);
    } catch (err: any) {
      clearTimeout(timer);
      controllers.delete(id);

      const result: WorkerResponse = {
        type: "FETCH_RESULT",
        id,
        payload: {
          statusCode: err?.name === "AbortError" ? 408 : 500,
          status: false,
          message: err?.message ?? "Request failed",
          data: undefined,
          errors: undefined,
        },
      };

      self.postMessage(result);
    }
  }

  // ── Message handler ──────────────────────────────────────

  self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    const msg = event.data;

    switch (msg.type) {
      case "SETUP": {
        const p = msg.payload;
        baseUrl = p.baseUrl.replace(/\/+$/, "");
        timeout = p.timeout;
        authMode = p.authMode;
        credentials = p.credentials;
        defaultHeaders = { ...defaultHeaders, ...p.defaultHeaders };
        refreshUrl = p.refreshUrl;

        if (p.initialAccessToken) {
          accessToken = p.initialAccessToken;
          expiresAt = parseExpiry(accessToken) ?? Date.now() + 300_000;
        }
        if (p.initialRefreshToken) {
          refreshToken = p.initialRefreshToken;
        }

        initBroadcast();
        broadcastAuthState();

        self.postMessage({ type: "READY" } satisfies WorkerResponse);
        break;
      }

      case "FETCH": {
        await executeRequest(msg);
        break;
      }

      case "AUTH_CALL": {
        const p = msg.payload;

        if (p.action === "setTokens") {
          accessToken = p.accessToken;
          refreshToken = p.refreshToken;
          expiresAt = p.expiresAt ?? parseExpiry(accessToken) ?? Date.now() + 300_000;
          broadcastAuthState();

          self.postMessage({
            type: "AUTH_RESULT",
            payload: { success: true, message: "Tokens set", expiresAt },
          } satisfies WorkerResponse);
        }

        if (p.action === "login") {
          try {
            const url = p.url ?? `${baseUrl}/auth/login`;
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(p.body),
              credentials,
            });
            const data = await res.json();

            if (res.ok) {
              accessToken = data.data?.access ?? data.access;
              refreshToken = data.data?.refresh ?? data.refresh;
              expiresAt = parseExpiry(accessToken!) ?? Date.now() + 300_000;
              currentUser = data.data?.user;
              broadcastAuthState();

              self.postMessage({
                type: "AUTH_RESULT",
                payload: {
                  success: true,
                  message: data.message ?? "Logged in",
                  user: currentUser,
                  expiresAt,
                },
              } satisfies WorkerResponse);
            } else {
              self.postMessage({
                type: "AUTH_RESULT",
                payload: { success: false, message: data.message ?? "Login failed" },
              } satisfies WorkerResponse);
            }
          } catch (err: any) {
            self.postMessage({
              type: "AUTH_RESULT",
              payload: { success: false, message: err.message },
            } satisfies WorkerResponse);
          }
        }

        if (p.action === "logout") {
          const url = p.url ?? `${baseUrl}/auth/logout`;
          try {
            await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(authMode === "header" && accessToken
                  ? { Authorization: `Bearer ${accessToken}` }
                  : {}),
              },
              credentials,
            });
          } catch { /* ignore */ }

          accessToken = null;
          refreshToken = null;
          expiresAt = null;
          currentUser = undefined;
          broadcast({ type: "LOGOUT", tabId });
          broadcastAuthState();

          self.postMessage({
            type: "AUTH_RESULT",
            payload: { success: true, message: "Logged out" },
          } satisfies WorkerResponse);
        }
        break;
      }

      case "CANCEL": {
        controllers.get(msg.id)?.abort();
        controllers.delete(msg.id);
        break;
      }

      case "PING": {
        self.postMessage({ type: "PONG" } satisfies WorkerResponse);
        break;
      }
    }
  };
})();