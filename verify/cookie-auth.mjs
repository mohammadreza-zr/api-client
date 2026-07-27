/**
 * Regression suite for `authMode: "cookie"` — httpOnly session detection.
 *
 * The bug: `isAuthenticated` was `Boolean(accessToken) && !expired`. In cookie
 * mode the tokens are httpOnly, so JS never sees an access token and the flag
 * was permanently `false` — even immediately after a successful login. Apps
 * could not tell a logged-in user from a logged-out one, so guards, redirects
 * and "logged in as…" UI never worked.
 *
 * Cookie mode now tracks an explicit session flag, driven by what the server
 * actually says, plus `restoreSession()` for the page-reload case where the
 * cookie exists but is unreadable.
 *
 * Runs every scenario in BOTH worker and inline mode: the user hitting this
 * was on the default (worker) path.
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

let pass = 0,
  fail = 0;

const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name} ${detail}`);
  }
};

const raw = readFileSync("src/worker/worker-source.ts", "utf8");
const WORKER_SOURCE = JSON.parse(raw.match(/WORKER_SOURCE = ("(?:[^"\\]|\\.)*")/s)[1]);

/**
 * Faithful DedicatedWorker emulation.
 *
 * Deliberately exposes NO localStorage, sessionStorage or document — that
 * absence is the whole point of this suite.
 */
class FakeWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this._listeners = new Set();
    this._closed = false;

    const host = this;
    const scope = {
      postMessage(data) {
        if (host._closed) return;
        const event = { data: structuredClone(data) };
        queueMicrotask(() => {
          host.onmessage?.(event);
          for (const l of host._listeners) l(event);
        });
      },
      close() {
        host._closed = true;
      },
      onmessage: null,
      addEventListener() {},
      removeEventListener() {},
      fetch: globalThis.fetch,
      Headers: globalThis.Headers,
      Request: globalThis.Request,
      Response: globalThis.Response,
      AbortController: globalThis.AbortController,
      AbortSignal: globalThis.AbortSignal,
      FormData: globalThis.FormData,
      Blob: globalThis.Blob,
      URLSearchParams: globalThis.URLSearchParams,
      URL: globalThis.URL,
      TextDecoder: globalThis.TextDecoder,
      TextEncoder: globalThis.TextEncoder,
      setTimeout,
      clearTimeout,
      queueMicrotask,
      console,
      structuredClone,
      DOMException: globalThis.DOMException,
      Date,
      Math,
      JSON,
      Promise,
      Error,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Symbol,
      Map,
      Set,
      RegExp,
      Uint8Array,
      atob: globalThis.atob,
      btoa: globalThis.btoa,
      // A real DedicatedWorkerGlobalScope exposes these; without them the
      // library cannot tell a worker apart from an SSR/Node scope and
      // silently disables cross-tab sync.
      importScripts() {},
      WorkerGlobalScope: function WorkerGlobalScope() {},
      BroadcastChannel: globalThis.BroadcastChannel,
    };
    scope.self = scope;
    scope.globalThis = scope;

    this._ctx = vm.createContext(scope);
    vm.runInContext(WORKER_SOURCE, this._ctx, { filename: "worker.js" });
    this._scope = scope;
  }

  postMessage(data) {
    if (this._closed) return;
    const event = { data: structuredClone(data) };
    queueMicrotask(() => {
      try {
        this._scope.onmessage?.(event);
      } catch (e) {
        this.onerror?.({ message: e.message });
      }
    });
  }

  addEventListener(_type, fn) {
    this._listeners.add(fn);
  }
  removeEventListener(_type, fn) {
    this._listeners.delete(fn);
  }
  terminate() {
    this._closed = true;
  }
}


// ── a Nuxt/Nitro-style httpOnly cookie backend ───────────

let sessions = new Set();
let seq = 0;

const server = createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }

  const cookie = req.headers.cookie ?? "";
  const match = cookie.match(/session=([^;]+)/);
  const active = Boolean(match && sessions.has(match[1]));

  const json = (code, body, extra = {}) => {
    res.writeHead(code, { "Content-Type": "application/json", ...extra });
    res.end(JSON.stringify(body));
  };

  if (req.url === "/api/auth/login") {
    const id = `s${++seq}`;
    sessions.add(id);
    // The token never reaches JS — that is the whole point of httpOnly.
    return json(200, { data: { user: { id: 1, email: "test@example.com" } } },
      { "Set-Cookie": `session=${id}; HttpOnly; Path=/; SameSite=Lax` });
  }

  if (req.url === "/api/auth/refresh") {
    return active ? json(200, { data: {} }) : json(401, { message: "no session" });
  }

  if (req.url === "/api/auth/logout") {
    if (match) sessions.delete(match[1]);
    return json(200, { data: null }, { "Set-Cookie": "session=; Max-Age=0; Path=/" });
  }

  if (req.url === "/api/auth/me") {
    return active
      ? json(200, { data: { id: 1, email: "test@example.com" } })
      : json(401, { message: "unauthenticated" });
  }

  return json(404, { message: "not found" });
});

await new Promise((r) => server.listen(4605, r));
const BASE = "http://localhost:4605";

// ── browser-ish cookie jar ───────────────────────────────

let jar = "";
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const headers = { ...(init.headers || {}) };
  if (jar) headers.cookie = jar;
  const res = await realFetch(input, { ...init, headers });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const raw of setCookie) {
    const [pair] = raw.split(";");
    jar = /Max-Age=0/.test(raw) ? "" : pair;
  }
  return res;
};

globalThis.Worker = FakeWorker;
globalThis.Blob = globalThis.Blob ?? class {};
globalThis.URL.createObjectURL = () => "blob:worker";
globalThis.URL.revokeObjectURL = () => {};
globalThis.window = globalThis;

const { createClient } = await import("../dist/index.js");

const make = (worker, extra = {}) =>
  createClient({
    baseUrl: BASE,
    worker,
    multiTab: false,
    throwError: false,
    authMode: "cookie",
    credentials: "include",
    loginUrl: "/api/auth/login",
    refreshUrl: "/api/auth/refresh",
    logoutUrl: "/api/auth/logout",
    ...extra,
  });

try {
  for (const worker of [true, false]) {
    const mode = worker ? "worker" : "inline";
    console.log(`\n[${mode}] login makes isAuthenticated true`);

    jar = "";
    sessions = new Set();

    {
      const api = make(worker);
      check(`${mode}: mode engaged as expected`, api.isWorker === worker);
      check(`${mode}: starts logged out`, (await api.getAuthState()).isAuthenticated === false);

      const res = await api.login({ email: "test@example.com", password: "password" });
      check(`${mode}: login succeeded`, res.status === true);

      const state = await api.getAuthState();
      check(
        `${mode}: isAuthenticated is true after login (was permanently false)`,
        state.isAuthenticated === true,
      );
      check(`${mode}: no token leaked into the state`, !JSON.stringify(state).includes("session="));
      check(`${mode}: user from the login body is exposed`, state.user?.email === "test@example.com");
      api.destroy();
    }

    console.log(`\n[${mode}] restoreSession recovers a session after reload`);
    {
      // The cookie survives; the client instance does not.
      const api = make(worker);
      check(
        `${mode}: cold state is false (httpOnly cookie is unreadable)`,
        (await api.getAuthState()).isAuthenticated === false,
      );

      const restored = await api.restoreSession("/api/auth/me");
      check(`${mode}: restoreSession detects the live session`, restored.isAuthenticated === true);
      check(`${mode}: restoreSession populates user`, restored.user?.email === "test@example.com");
      check(
        `${mode}: getAuthState agrees afterwards`,
        (await api.getAuthState()).isAuthenticated === true,
      );
      api.destroy();
    }

    console.log(`\n[${mode}] restoreSession without a probe URL`);
    {
      const api = make(worker);
      const restored = await api.restoreSession();
      check(`${mode}: falls back to the refresh endpoint`, restored.isAuthenticated === true);
      api.destroy();
    }

    console.log(`\n[${mode}] ordinary requests keep the flag honest`);
    {
      const api = make(worker);
      await api.restoreSession("/api/auth/me");

      const ok = await api.get("/api/auth/me");
      check(`${mode}: authenticated request succeeds`, ok.status === true);
      check(`${mode}: still authenticated`, (await api.getAuthState()).isAuthenticated === true);

      // Session revoked server-side (or expired) → the next 401 must flip it.
      sessions.clear();
      const denied = await api.get("/api/auth/me");
      check(`${mode}: request now fails`, denied.status === false);
      check(
        `${mode}: a 401 marks the session dead`,
        (await api.getAuthState()).isAuthenticated === false,
      );
      api.destroy();
    }

    console.log(`\n[${mode}] logout`);
    {
      jar = "";
      sessions = new Set();
      const api = make(worker);
      await api.login({ email: "test@example.com", password: "password" });
      check(`${mode}: authenticated before logout`, (await api.getAuthState()).isAuthenticated === true);

      await api.logout();
      check(`${mode}: logged out`, (await api.getAuthState()).isAuthenticated === false);

      const after = make(worker);
      check(
        `${mode}: a reload after logout stays logged out`,
        (await after.restoreSession("/api/auth/me")).isAuthenticated === false,
      );
      after.destroy();
      api.destroy();
    }

    console.log(`\n[${mode}] no session at all`);
    {
      jar = "";
      sessions = new Set();
      const api = make(worker);
      const restored = await api.restoreSession("/api/auth/me");
      check(`${mode}: restoreSession reports false for a fresh visitor`, restored.isAuthenticated === false);
      check(`${mode}: no user is invented`, restored.user === undefined);
      api.destroy();
    }

    console.log(`\n[${mode}] onAuthStateChange fires`);
    {
      jar = "";
      sessions = new Set();
      const api = make(worker);
      const seen = [];
      api.onAuthStateChange((s) => seen.push(s.isAuthenticated));
      await api.login({ email: "test@example.com", password: "password" });
      await new Promise((r) => setTimeout(r, 60));
      check(`${mode}: observers were told about the login`, seen.includes(true), JSON.stringify(seen));
      api.destroy();
    }
  }

  console.log("\nrelative URLs need no baseUrl workaround in worker mode");
  {
    /*
     * A Blob worker's base URL is `blob:http://origin/uuid`, and a relative
     * request cannot resolve against it — `new URL("/me", "blob:...")` throws.
     * Users worked around this by passing `baseUrl: window.location.origin`,
     * which then breaks SSR. The host now falls back to the page origin so
     * relative URLs behave the same in both modes.
     */
    check(
      "a relative URL genuinely cannot resolve against a blob: base",
      (() => {
        try {
          new URL("/api/auth/me", "blob:http://localhost:4605/uuid-1");
          return false;
        } catch {
          return true;
        }
      })(),
    );

    const savedOrigin = globalThis.location;
    const savedCreate = globalThis.URL.createObjectURL;
    globalThis.location = { origin: BASE, protocol: "http:" };
    globalThis.URL.createObjectURL = () => `blob:${BASE}/uuid-1`;

    jar = "";
    sessions = new Set();

    // The user's config, minus the baseUrl workaround.
    const api = createClient({
      worker: true,
      multiTab: false,
      throwError: false,
      authMode: "cookie",
      credentials: "include",
      loginUrl: "/api/auth/login",
      refreshUrl: "/api/auth/refresh",
      logoutUrl: "/api/auth/logout",
    });
    check("worker mode engaged without baseUrl", api.isWorker === true);

    const login = await api.login({ email: "test@example.com", password: "password" });
    check("relative loginUrl resolves inside the worker", login.status === true, login.message);
    check("session detected", (await api.getAuthState()).isAuthenticated === true);

    const me = await api.get("/api/auth/me");
    check("relative request URL resolves inside the worker", me.status === true, me.message);

    api.destroy();
    globalThis.location = savedOrigin;
    globalThis.URL.createObjectURL = savedCreate;
  }

  console.log("\nheader mode is unaffected");
  {
    const api = createClient({
      baseUrl: BASE,
      worker: false,
      multiTab: false,
      throwError: false,
      authMode: "header",
    });
    // No request should be made, and nothing should be invented.
    const restored = await api.restoreSession();
    check("header mode: restoreSession is a no-op returning current state", restored.isAuthenticated === false);
    api.destroy();
  }
} catch (e) {
  fail++;
  console.error("\nUNEXPECTED:", e);
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
