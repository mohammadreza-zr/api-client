/**
 * Drives the REAL inlined worker bundle through the REAL WorkerHost protocol.
 *
 * There is no browser in Node, so this installs `Worker`/`Blob`/
 * `URL.createObjectURL` and runs the worker source inside a vm context whose
 * `self` is wired to a message channel — the same contract a browser provides.
 * Shared by every worker-mode suite; import it before the client. Not part of
 * the package.
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";

// Extract the inlined worker source exactly as shipped.
const raw = readFileSync("src/worker/worker-source.ts", "utf8");
const WORKER_SOURCE = JSON.parse(raw.match(/WORKER_SOURCE = ("(?:[^"\\]|\\.)*")/s)[1]);

/** Every fake worker created, so a test can crash the one a client owns. */
export const madeWorkers = [];

/**
 * Faithful DedicatedWorker emulation.
 *
 * Deliberately exposes NO localStorage, sessionStorage or document: a real
 * worker has none, and the storage suite depends on that absence.
 */
export class FakeWorker {
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
    madeWorkers.push(this);
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
  /** Fires the worker's `onerror` — what a real browser does on a crash. */
  crashNow(message = "simulated worker crash") {
    this.onerror?.({ message });
  }
}

globalThis.Worker = FakeWorker;
globalThis.Blob = globalThis.Blob ?? class {};
globalThis.URL.createObjectURL = () => "blob:worker";
globalThis.URL.revokeObjectURL = () => {};
// Make the library believe it is in a browser so worker mode engages.
globalThis.window = globalThis;
