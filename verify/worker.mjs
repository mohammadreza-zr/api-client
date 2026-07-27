/**
 * Drives the REAL inlined worker bundle through the REAL WorkerHost protocol.
 *
 * There is no browser here, so we polyfill `Worker`/`Blob`/`URL.createObjectURL`
 * and execute the worker source inside a vm context whose `self` is wired to a
 * message channel — the same contract a browser provides.
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { start, state, expireAccess } from "./server.mjs";

const BASE = "http://localhost:4600";
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

// Extract the inlined worker source exactly as shipped.
const raw = readFileSync("src/worker/worker-source.ts", "utf8");
const WORKER_SOURCE = JSON.parse(raw.match(/WORKER_SOURCE = ("(?:[^"\\]|\\.)*")/s)[1]);

/** Minimal but faithful DedicatedWorker emulation. */
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
    // No BroadcastChannel in this harness → single-tab behaviour.

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

globalThis.Worker = FakeWorker;
globalThis.Blob = globalThis.Blob ?? class {};
globalThis.URL.createObjectURL = () => "blob:worker";
globalThis.URL.revokeObjectURL = () => {};
// Make the library believe it is in a browser so worker mode engages.
globalThis.window = globalThis;

const { server } = await start(4600);
const { createClient } = await import("../dist/index.js");

try {
  console.log("\nworker mode");
  let states = [];
  const api = createClient({
    baseUrl: BASE,
    multiTab: false,
    refreshSkewMs: 0,
    throwError: false, // envelope style — this suite asserts on result objects
    onAuthStateChanged: (s) => states.push(s.isAuthenticated),
  });

  check("worker mode engaged", api.isWorker === true);

  const echo = await api.get("/echo", { params: { a: 1, nested: { b: 2 }, list: [1, 2] } });
  check("GET through worker", echo.status === true);
  check(
    "worker uses SAME nested query serializer as main thread (was [object Object])",
    echo.data.query === "?a=1&nested%5Bb%5D=2&list=1&list=2",
    echo.data.query,
  );

  const posted = await api.post("/echo", { hi: 1 });
  check("POST through worker", posted.data.body.hi === 1);

  // transforms must survive the structured-clone boundary
  const tr = await api.post(
    "/echo",
    { name: "ada" },
    { beforeFunc: (b) => ({ ...b, name: b.name.toUpperCase() }), afterFunc: (d) => d.body.name },
  );
  check("beforeFunc/afterFunc work in worker mode (were dropped)", tr.data === "ADA", JSON.stringify(tr.data));

  // per-request baseUrl override
  const over = await api.get("/echo", { baseUrl: BASE });
  check("per-request baseUrl works in worker", over.status === true);

  // errors
  const boom = await api.get("/boom");
  check("500 handled in worker", boom.status === false && boom.statusCode === 500);
  const inv = await api.get("/invalid");
  check("field errors in worker", inv.errors?.name?.[0] === "required");

  // timeout parity
  const slow = await api.get("/slow", { timeout: 300 });
  check("worker timeout → 408 (parity with main thread)", slow.statusCode === 408, `got ${slow.statusCode}`);

  // auth in worker
  const login = await api.login({ password: "good" });
  check("login through worker", login.status === true);
  const st = await api.getAuthState();
  check("auth state readable", st.isAuthenticated === true);
  check("auth state carries NO tokens", !("accessToken" in st) && !JSON.stringify(st).includes("eyJ"));
  check("auth observers fired in worker", states.includes(true));

  const prot = await api.get("/protected");
  check("authorized request in worker", prot.status === true);

  state.refreshCalls = 0;
  expireAccess();
  const burst = await Promise.all(Array.from({ length: 6 }, () => api.get("/protected")));
  check("worker: 6 concurrent 401s all recover", burst.every((r) => r.status === true));
  check("worker: coalesced to 1 refresh", state.refreshCalls === 1, `got ${state.refreshCalls}`);

  // concurrent auth calls must not deadlock (old code shared one "__auth__" slot)
  const [l1, l2] = await Promise.all([api.login({ password: "good" }), api.login({ password: "bad" })]);
  check("overlapping login calls both settle (was: hang forever)", l1 !== undefined && l2 !== undefined);
  check("overlapping calls get distinct results", l1.status !== l2.status);

  await api.logout();
  check("logout in worker", (await api.getAuthState()).isAuthenticated === false);

  api.destroy();
  check("destroy is clean", true);

  // ── client-wide throwError must behave identically in worker mode ──
  const strict = createClient({
    baseUrl: BASE,
    refreshSkewMs: 0,
    throwError: true,
    onError: () => {},
  });
  check("worker mode engaged for strict client", strict.isWorker === true);

  let workerThrew = false;
  let workerErr;
  try {
    await strict.get("/boom");
  } catch (e) {
    workerThrew = true;
    workerErr = e;
  }
  check("worker: client-wide throwError rejects", workerThrew);
  check(
    "worker: rejection is ApiError with statusCode 500",
    workerErr?.name === "ApiError" && workerErr?.statusCode === 500,
    `${workerErr?.name}/${workerErr?.statusCode}`,
  );

  const strictOk = await strict.get("/echo");
  check("worker: success still resolves under throwError", strictOk.status === true);

  let workerOptOut = false;
  try {
    const r = await strict.get("/boom", { throwError: false });
    workerOptOut = r.status === false && r.statusCode === 500;
  } catch {
    workerOptOut = false;
  }
  check("worker: per-request throwError:false overrides default", workerOptOut);

  strict.destroy();

  // ── CSRF must work in worker mode, where document.cookie does not exist ──
  const csrfApi = createClient({
    baseUrl: BASE,
    refreshSkewMs: 0,
    throwError: false,
    getCsrfToken: () => "worker-csrf-1", // a function cannot be cloned into the worker
    onError: () => {},
  });
  check("worker mode engaged with a CSRF provider", csrfApi.isWorker === true);

  const csrfEcho = await csrfApi.post("/echo", { a: 1 });
  check(
    "worker: CSRF header reaches the server",
    csrfEcho.data?.csrf === "worker-csrf-1",
    `got ${csrfEcho.data?.csrf}`,
  );

  const csrfGet = await csrfApi.get("/echo");
  check("worker: GET carries no CSRF header", !csrfGet.data?.csrf, `got ${csrfGet.data?.csrf}`);

  // A stream cannot be structured-cloned; the failure must be legible.
  const streamRes = await csrfApi.post(
    "/echo",
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("x"));
        c.close();
      },
    }),
  );
  check(
    "worker: stream body fails with a clear message, not DataCloneError",
    streamRes.status === false && /worker: false|Blob\/File\/FormData/i.test(streamRes.message),
    streamRes.message,
  );

  csrfApi.destroy();

  strict.destroy();

  /*
   * baseUrl auto-detection must survive the worker boundary.
   *
   * The worker runs from a Blob, so no bundler ever touched its source and it
   * has no `process` / `import.meta.env` of its own — note the vm scope above
   * deliberately omits `process`, exactly like a real browser worker. The host
   * therefore has to resolve `baseUrl` on the main thread and forward it. It
   * used to forward `undefined`, so every relative URL in worker mode was
   * silently sent to the page origin.
   */
  console.log("\nbaseUrl auto-detection in worker mode");

  check("worker scope genuinely has no process", (() => {
    const probe = new FakeWorker();
    const seen = typeof probe._scope.process;
    probe.terminate();
    return seen === "undefined";
  })());

  for (const key of ["NEXT_PUBLIC_API_URL", "VITE_API_URL", "API_URL"]) {
    process.env[key] = BASE;
    const detected = createClient({ multiTab: false, refreshSkewMs: 0, throwError: false });
    check(`worker mode engaged for ${key}`, detected.isWorker === true);
    const res = await detected.get("/echo");
    check(`worker inherits baseUrl from ${key} (was sent to page origin)`, res.status === true, res.message);
    detected.destroy();
    delete process.env[key];
  }

  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:9/wrong";
  const explicit = createClient({ baseUrl: BASE, multiTab: false, refreshSkewMs: 0, throwError: false });
  const explicitRes = await explicit.get("/echo");
  check("worker: explicit baseUrl still beats env", explicitRes.status === true);
  explicit.destroy();
  delete process.env.NEXT_PUBLIC_API_URL;
} catch (e) {
  fail++;
  console.error("\nUNEXPECTED:", e);
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
