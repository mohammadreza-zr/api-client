/**
 * Regression suite for token persistence — in WORKER MODE, which is the default.
 *
 * The bug: `storage` was forwarded into the worker, which built the adapter in
 * its own scope. But `localStorage`, `sessionStorage` and `document.cookie` are
 * Window APIs that do not exist in a worker. `WebStorage` caught the resulting
 * error and returned null, so every write was silently discarded — `"local"`,
 * `"session"` and `"cookie"` all behaved exactly like `"memory"` and users were
 * logged out on every reload. A custom adapter object separately disabled
 * worker mode altogether.
 *
 * Storage is now owned by the main thread and the worker persists through it.
 *
 * This drives the REAL inlined worker bundle through the REAL host protocol,
 * in a vm scope that — like a browser worker — has no Window storage APIs.
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { start } from "./server.mjs";

const BASE = "http://localhost:4603";
let pass = 0,
  fail = 0;

const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
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

// ── main-thread (Window) environment ─────────────────────

const local = new Map();
const session = new Map();
let cookieJar = "";

const webStorage = (map) => ({
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
});

globalThis.localStorage = webStorage(local);
globalThis.sessionStorage = webStorage(session);
Object.defineProperty(globalThis, "document", {
  configurable: true,
  get: () => ({
    get cookie() {
      return cookieJar;
    },
    set cookie(v) {
      const [pair] = v.split(";");
      const [k] = pair.split("=");
      const others = cookieJar.split("; ").filter((c) => c && !c.startsWith(`${k}=`));
      cookieJar = /Expires=Thu, 01 Jan 1970/.test(v) ? others.join("; ") : [...others, pair].join("; ");
    },
  }),
});

globalThis.Worker = FakeWorker;
globalThis.Blob = globalThis.Blob ?? class {};
globalThis.URL.createObjectURL = () => "blob:worker";
globalThis.URL.revokeObjectURL = () => {};
globalThis.window = globalThis;

const reset = () => {
  local.clear();
  session.clear();
  cookieJar = "";
};

const written = {
  local: () => [...local.keys()],
  session: () => [...session.keys()],
  cookie: () => (cookieJar ? [cookieJar.split("=")[0]] : []),
};

const { server } = await start(4603);
const { createClient } = await import("../dist/index.js");

const make = (options = {}) =>
  createClient({ baseUrl: BASE, multiTab: false, throwError: false, ...options });

try {
  console.log("\nthe worker scope really lacks Window storage APIs");
  {
    const probe = new FakeWorker();
    const missing = ["localStorage", "sessionStorage", "document"].filter(
      (k) => typeof probe._scope[k] === "undefined",
    );
    probe.terminate();
    check("worker has no localStorage/sessionStorage/document", missing.length === 3, missing.join(","));
  }

  console.log("\ntokens are persisted from worker mode");

  for (const kind of ["local", "session", "cookie"]) {
    reset();
    const api = make({ storage: kind });
    check(`${kind}: worker mode engaged`, api.isWorker === true);

    const login = await api.login({ password: "good" });
    check(`${kind}: login succeeded`, login.status === true);
    check(
      `${kind}: token record actually written (was silently dropped)`,
      written[kind]().length === 1,
      JSON.stringify(written[kind]()),
    );
    api.destroy();
  }

  console.log("\nsession survives a page reload");

  for (const kind of ["local", "session", "cookie"]) {
    reset();
    const first = make({ storage: kind });
    await first.login({ password: "good" });
    first.destroy();

    // A reload is a brand-new client reading the same storage.
    const second = make({ storage: kind });
    const state = await second.getAuthState();
    check(`${kind}: still authenticated after reload (was logged out)`, state.isAuthenticated === true);

    const protectedRes = await second.get("/protected");
    check(`${kind}: rehydrated token authorizes a request`, protectedRes.status === true);
    second.destroy();
  }

  console.log("\nmemory stays ephemeral, by design");
  {
    reset();
    const first = make({ storage: "memory" });
    await first.login({ password: "good" });
    check("memory: nothing written to localStorage", written.local().length === 0);
    check("memory: nothing written to cookies", written.cookie().length === 0);
    first.destroy();

    const second = make({ storage: "memory" });
    check(
      "memory: logged out after reload (the documented tradeoff)",
      (await second.getAuthState()).isAuthenticated === false,
    );
    second.destroy();
  }

  console.log("\ndefault storage is memory");
  {
    reset();
    const api = make();
    await api.login({ password: "good" });
    check("no storage option → nothing persisted", written.local().length === 0 && written.cookie().length === 0);
    api.destroy();
  }

  console.log("\nlogout clears persisted tokens");
  {
    reset();
    const api = make({ storage: "local" });
    await api.login({ password: "good" });
    await api.logout();
    check("logout removes the stored record", written.local().length === 0, JSON.stringify(written.local()));

    const after = make({ storage: "local" });
    check("no resurrection after reload", (await after.getAuthState()).isAuthenticated === false);
    after.destroy();
    api.destroy();
  }

  console.log("\nstorageKey namespacing");
  {
    reset();
    const api = make({ storage: "local", storageKey: "acme-admin" });
    await api.login({ password: "good" });
    check("custom storageKey honoured", written.local()[0] === "acme-admin.tokens", JSON.stringify(written.local()));
    api.destroy();

    // A differently-keyed client must not see that session.
    const other = make({ storage: "local", storageKey: "acme-public" });
    check("a different storageKey is isolated", (await other.getAuthState()).isAuthenticated === false);
    other.destroy();
  }

  console.log("\nsetTokens (SSR / OAuth seeding) persists too");
  {
    reset();
    const api = make({ storage: "local" });
    await api.setTokens({ accessToken: "seeded-access", refreshToken: "seeded-refresh" });
    check("setTokens writes through to storage", written.local().length === 1);

    const after = make({ storage: "local" });
    check("seeded session survives reload", (await after.getAuthState()).isAuthenticated === true);
    after.destroy();
    api.destroy();
  }

  console.log("\ncustom adapter objects keep worker isolation");
  {
    reset();
    const box = new Map();
    const calls = [];
    const custom = {
      get: () => {
        calls.push("get");
        return box.get("t") ?? null;
      },
      set: (t) => {
        calls.push("set");
        box.set("t", t);
      },
      clear: () => {
        calls.push("clear");
        box.delete("t");
      },
    };

    const api = make({ storage: custom });
    check("custom adapter no longer forces worker mode off", api.isWorker === true);

    await api.login({ password: "good" });
    check("custom adapter received the tokens", box.has("t"));
    check("custom adapter was called from the worker", calls.includes("set"));
    api.destroy();

    const after = make({ storage: custom });
    check("custom adapter rehydrates after reload", (await after.getAuthState()).isAuthenticated === true);
    after.destroy();
  }

  console.log("\nasync custom adapters are awaited");
  {
    reset();
    const box = new Map();
    const slow = {
      get: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return box.get("t") ?? null;
      },
      set: async (t) => {
        await new Promise((r) => setTimeout(r, 20));
        box.set("t", t);
      },
      clear: async () => box.delete("t"),
    };

    const api = make({ storage: slow });
    await api.login({ password: "good" });
    check("async adapter persisted", box.has("t"));
    api.destroy();

    const after = make({ storage: slow });
    check("async adapter rehydrated", (await after.getAuthState()).isAuthenticated === true);
    after.destroy();
  }

  console.log("\na throwing adapter must not break auth");
  {
    reset();
    const hostile = {
      get: () => {
        throw new Error("storage exploded");
      },
      set: () => {
        throw new Error("quota exceeded");
      },
      clear: () => {
        throw new Error("nope");
      },
    };

    const api = make({ storage: hostile });
    const login = await api.login({ password: "good" });
    check("login still succeeds when storage throws", login.status === true);
    check("session is usable in-memory", (await api.getAuthState()).isAuthenticated === true);
    const res = await api.get("/protected");
    check("requests still authorized when storage throws", res.status === true);
    api.destroy();
  }

  console.log("\nthe memory default still keeps tokens out of the main thread");
  {
    reset();
    const seen = [];
    const RealWorker = globalThis.Worker;
    // Tap every message crossing the boundary for this one client.
    globalThis.Worker = class extends RealWorker {
      postMessage(data) {
        seen.push(JSON.stringify(data ?? null));
        return super.postMessage(data);
      }
      set onmessage(fn) {
        super.onmessage = (event) => {
          seen.push(JSON.stringify(event?.data ?? null));
          return fn?.(event);
        };
      }
      get onmessage() {
        return super.onmessage;
      }
    };

    const api = make({ storage: "memory" });
    await api.login({ password: "good" });
    await api.get("/protected");
    const state = await api.getAuthState();
    api.destroy();
    globalThis.Worker = RealWorker;

    const traffic = seen.join("|");
    check("memory mode: no JWT ever crosses to the main thread", !traffic.includes("eyJ"), "a token was posted out");
    check("memory mode: no storage bridge traffic at all", !traffic.includes('"kind":"storage"'));
    check("auth state carries no tokens", !JSON.stringify(state).includes("eyJ"));
  }

  console.log("\ncookie authMode keeps tokens server-side");
  {
    reset();
    const api = make({ storage: "local", authMode: "cookie" });
    await api.login({ password: "good" });
    check("cookie authMode writes no local token record", written.local().length === 0);
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
