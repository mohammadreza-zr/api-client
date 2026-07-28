/**
 * Cancellation through the REAL inlined worker bundle and the REAL host
 * protocol.
 *
 * This is the half that matters most: the registry lives on the main thread,
 * but the `fetch` it has to stop is inside the worker. A cancellation is only
 * genuine if it crosses that boundary and closes the socket — anything less is
 * cosmetic, and the promise would still resolve with a stale response.
 *
 * Not part of the package.
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = 4650;
const BASE = `http://localhost:${PORT}`;
let pass = 0,
  fail = 0;
const failures = [];

const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(`${name} ${detail}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name} \x1b[2m${detail}\x1b[0m`);
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

globalThis.Worker = FakeWorker;
globalThis.Blob = globalThis.Blob ?? class {};
globalThis.URL.createObjectURL = () => "blob:worker";
globalThis.URL.revokeObjectURL = () => {};
// Make the library believe it is in a browser so worker mode engages.
globalThis.window = globalThis;

// ── server ───────────────────────────────────────────────

const state = { aborted: 0, completed: 0 };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const json = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const delay = Number(url.searchParams.get("delay") ?? 0);
  if (delay > 0) {
    let done = false;
    req.on("aborted", () => {
      if (!done) state.aborted++;
    });
    await new Promise((r) => setTimeout(r, delay));
    done = true;
    if (res.writableEnded || req.destroyed) return;
  }

  state.completed++;
  return json(200, { data: { path: url.pathname } });
});

await new Promise((r) => server.listen(PORT, r));

const { createClient, ApiError } = await import("../dist/index.js");
const settle = () => new Promise((r) => setTimeout(r, 40));

try {
  console.log("\nworker mode: cancellation crosses the boundary");
  {
    const api = createClient({
      baseUrl: BASE,
      multiTab: false,
      throwError: false,
      cancel: true,
    });
    check("worker mode engaged", api.isWorker === true);

    const before = state.aborted;
    const p = api.get("/api/v1/products/12", { params: { delay: 600 } });
    await settle();

    check("host tracks the request while the worker runs it", api.pending().length === 1);
    check("pending() path is resolved on the host", api.pending()[0].path === "/api/v1/products/12");

    check("cancel() reports the stop", api.cancel(undefined, "route change") === 1);
    const res = await p;

    check("worker request resolves canceled", res.canceled === true);
    check("worker cancel → statusCode 0", res.statusCode === 0);
    check("worker cancel carries the reason", res.cancelReason === "route change");
    check("worker cancel message mentions the reason", res.message.includes("route change"));

    await new Promise((r) => setTimeout(r, 120));
    check(
      "the real fetch stopped: server saw an aborted socket",
      state.aborted > before,
      `${before} → ${state.aborted}`,
    );
    check("registry released after cancel", api.pending().length === 0);
    api.destroy();
  }

  console.log("\nworker mode: selectors");
  {
    const api = createClient({ baseUrl: BASE, multiTab: false, throwError: false, cancel: true });

    const a = api.get("/api/v1/products", { params: { delay: 400 } });
    const b = api.get("/api/v1/products/12", { params: { delay: 400 } });
    const c = api.get("/api/v1/orders", { params: { delay: 400 } });
    await settle();

    check("three worker requests tracked", api.pending().length === 3);
    check("URL pattern cancels the subtree", api.cancel("/api/v1/products") === 2);

    const [ra, rb, rc] = await Promise.all([a, b, c]);
    check("pattern-matched worker request 1 canceled", ra.canceled === true);
    check("pattern-matched worker request 2 canceled", rb.canceled === true);
    check("unmatched worker request completed", rc.status === true);

    // key + group
    const k = api.get("/search", { cancelKey: "q", params: { delay: 300 } });
    const g = api.get("/cart", { cancelGroup: "checkout", params: { delay: 300 } });
    await settle();
    check("cancel by key in worker mode", api.cancel("q") === 1);
    check("cancel by group in worker mode", api.cancel("checkout") === 1);
    check("keyed worker request canceled", (await k).canceled === true);
    check("grouped worker request canceled", (await g).canceled === true);
    api.destroy();
  }

  console.log("\nworker mode: takeLatest & scopes");
  {
    const api = createClient({ baseUrl: BASE, multiTab: false, throwError: false, cancel: true });

    const first = api.get("/search", { cancelKey: "s", takeLatest: true, params: { delay: 500 } });
    await settle();
    const second = api.get("/search", { cancelKey: "s", takeLatest: true, params: { delay: 100 } });
    await settle();

    check("takeLatest leaves one in flight in worker mode", api.pending("s").length === 1);
    const r1 = await first;
    check("worker: superseded request canceled", r1.canceled === true);
    check("worker: supersession reason", r1.cancelReason === "superseded by a newer request");
    check("worker: newest completes", (await second).status === true);

    const scope = api.cancelScope("modal");
    const s1 = scope.get("/api/v1/products/12", { params: { delay: 400 } });
    const s2 = scope.get("/api/v1/products/12/reviews", { params: { delay: 400 } });
    const outside = api.get("/api/v1/orders", { params: { delay: 400 } });
    await settle();

    check("worker: scope tracks its requests", scope.pending().length === 2);
    check("worker: scope.cancel() stops them", scope.cancel() === 2);
    const [rs1, rs2, ro] = await Promise.all([s1, s2, outside]);
    check("worker: scoped request 1 canceled", rs1.canceled === true);
    check("worker: scoped request 2 canceled", rs2.canceled === true);
    check("worker: request outside the scope survived", ro.status === true);
    api.destroy();
  }

  console.log("\nworker mode: throwing, opt-in and timeouts");
  {
    // Default client: throwError is on, but a cancellation still resolves.
    const api = createClient({ baseUrl: BASE, multiTab: false, cancel: true });
    const p = api.get("/api/v1/products", { params: { delay: 400 } });
    await settle();
    api.cancel(undefined, "navigated");

    let error = null;
    let res = null;
    try {
      res = await p;
    } catch (e) {
      error = e;
    }
    check("worker: cancel resolves under the default throwError:true", error === null);
    check("worker: resolved envelope is flagged canceled", res?.canceled === true);
    check("worker: resolved envelope carries the reason", res?.cancelReason === "navigated");
    api.destroy();
  }

  {
    // Opting back in, across the worker boundary.
    const api = createClient({ baseUrl: BASE, multiTab: false, cancel: { throwOnCancel: true } });
    const p = api.get("/api/v1/products", { params: { delay: 400 } });
    await settle();
    api.cancel(undefined, "navigated");

    let error = null;
    try {
      await p;
    } catch (e) {
      error = e;
    }
    check("worker: throwOnCancel:true rejects", error instanceof ApiError);
    check("worker: ApiError.canceled", error?.canceled === true);
    check("worker: ApiError.cancelReason", error?.cancelReason === "navigated");
    api.destroy();
  }

  {
    // Opt-in is respected in worker mode too.
    const api = createClient({ baseUrl: BASE, multiTab: false, throwError: false });
    const p = api.get("/api/v1/products", { params: { delay: 200 } });
    await settle();
    check("worker: nothing tracked without the opt-in", api.pending().length === 0);
    check("worker: cancel() is a no-op without the opt-in", api.cancel() === 0);
    check("worker: untracked request completes", (await p).status === true);
    api.destroy();
  }

  {
    const api = createClient({ baseUrl: BASE, multiTab: false, throwError: false, cancel: true });
    const p = api.post("/orders", { sku: "X" }, { params: { delay: 200 } });
    await settle();
    check("worker: POST not tracked by default", api.pending().length === 0);
    check("worker: POST survives cancel()", (await p).status === true);

    const opted = api.post("/orders", { sku: "Y" }, { cancelable: true, params: { delay: 300 } });
    await settle();
    check("worker: POST tracked when opted in", api.pending().length === 1);
    api.cancel();
    check("worker: opted-in POST cancels", (await opted).canceled === true);
    api.destroy();
  }

  {
    const api = createClient({ baseUrl: BASE, multiTab: false, throwError: false, cancel: true });

    // Timeout must stay distinct from cancellation across the boundary.
    const timedOut = await api.get("/api/v1/products", { params: { delay: 400 }, timeout: 120 });
    check("worker: timeout → 408", timedOut.statusCode === 408, `got ${timedOut.statusCode}`);
    check("worker: timeout is not flagged canceled", !timedOut.canceled);

    // A caller's own AbortSignal still works and is flagged.
    const ac = new AbortController();
    const p = api.get("/api/v1/products", { signal: ac.signal, params: { delay: 400 } });
    await settle();
    ac.abort();
    const res = await p;
    check("worker: user AbortSignal cancels", res.canceled === true);
    check("worker: user abort keeps the classic message", res.message === "Request aborted");
    api.destroy();
  }

  console.log("\nworker mode: onError & destroy");
  {
    const seen = [];
    const api = createClient({
      baseUrl: BASE,
      multiTab: false,
      throwError: false,
      cancel: true,
      onError: (e) => seen.push(e),
    });
    const p = api.get("/api/v1/products", { params: { delay: 300 } });
    await settle();
    api.cancel();
    await p;
    check("worker: cancel does not fire onError", seen.length === 0);
    api.destroy();
  }

  {
    const api = createClient({ baseUrl: BASE, multiTab: false, throwError: false, cancel: true });
    const p = api.get("/api/v1/products", { params: { delay: 400 } });
    await settle();
    api.destroy();
    const res = await p;
    check("worker: destroy() cancels in-flight requests", res.status === false);
  }
} finally {
  server.close();
}

console.log(`\n\x1b[1mresult\x1b[0m  ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
