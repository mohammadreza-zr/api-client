import type { AuthState, ClientOptions, TokenPair, TokenStorage } from "../types";
import type { HostMessage, WorkerMessage } from "./protocol";
import { reasonOf } from "../internal/cancel";
import { createCsrfReader, type CsrfReader } from "../internal/cookie";
import { callHook } from "../internal/hooks";
import { resolveStorage } from "../internal/storage";
import { toSerializableOptions } from "./host-options";
import { WORKER_SOURCE } from "./worker-source";

/**
 * A worker that has not booted by then is treated as blocked (a CSP
 * `worker-src` rule, an extension, a broken runtime).
 */
const BOOT_TIMEOUT_MS = 10_000;

type Pending = { resolve: (value: never) => void; reject: (error: Error) => void };

export interface ChannelEvents {
  authChanged(state: AuthState): void;
  /** The worker never booted; the owner should run in the page instead. */
  bootFailed(): void;
}

/**
 * The transport to the request worker: boot, crash recovery, RPC calls, and
 * the bridge serving what only the main thread has (storage, cookies).
 */
export class WorkerChannel {
  private worker!: Worker;
  private objectUrl: string | null = null;
  private seq = 0;
  private calls = new Map<number, Pending>();
  private ready!: Promise<void>;
  private resolveReady: () => void = () => {};
  private booted = false;
  private bootTimer: ReturnType<typeof setTimeout> | undefined;
  private crashed = false;
  private crashError: Error | null = null;
  /** Only one automatic restart is attempted; a second crash fails fast. */
  private restartAttempted = false;
  private destroyed = false;
  private readCsrf: CsrfReader;
  /** Main-thread storage the worker persists through. `null` for memory. */
  private storage: TokenStorage | null;

  constructor(
    private options: ClientOptions,
    private baseUrl: string,
    private events: ChannelEvents,
  ) {
    this.readCsrf = createCsrfReader(options);
    // localStorage / sessionStorage / document.cookie only exist here, so the worker persists through us.
    const kind = options.storage ?? "memory";
    this.storage = kind === "memory" ? null : resolveStorage(kind, options.storageKey ?? "apiclient");
    this.spawn();
  }

  /** Resolves once the worker booted, fell back, crashed, or was destroyed. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  private spawn(): void {
    if (this.objectUrl === null) {
      this.objectUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    }

    const worker = new Worker(this.objectUrl);
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => this.receive(event.data);
    // Browsers report a CSP-blocked worker asynchronously, here, not as a constructor throw.
    worker.onerror = (event) => {
      if (this.worker === worker) this.crash(new Error(event.message || "Worker crashed"));
    };

    this.ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
    if (!this.booted) {
      this.bootTimer = setTimeout(() => this.crash(new Error("Worker did not start")), BOOT_TIMEOUT_MS);
      (this.bootTimer as { unref?: () => void }).unref?.();
    }

    this.dispatch({ kind: "init", options: toSerializableOptions(this.options, this.baseUrl) });
  }

  /**
   * Handles a dead worker. Before it ever booted, hand over to the page. After
   * that, in-flight calls fail with an actionable message and one restart is
   * attempted when the session survives in host storage.
   */
  private crash(error: Error): void {
    if (this.crashed || this.destroyed) return;
    clearTimeout(this.bootTimer);

    if (!this.booted) {
      // Marked crashed so a second error event can't hand over twice.
      this.crashed = true;
      this.worker.terminate();
      this.events.bootFailed();
      this.resolveReady();
      return;
    }

    this.crashed = true;
    const canRestart = this.storage !== null && !this.restartAttempted;
    const rejection = new Error(
      canRestart
        ? "The request worker crashed and is being restarted from host storage — retry the request."
        : "The request worker crashed and cannot be restarted: the session lived in its " +
            "closure and is lost. Recreate the client and re-authenticate, or pass " +
            "worker: false to run on the main thread.",
    );
    (rejection as { cause?: unknown }).cause = error;

    this.resolveReady();
    for (const [, entry] of this.calls) entry.reject(rejection);
    this.calls.clear();

    if (!canRestart) {
      this.crashError = rejection;
      return;
    }
    this.restartAttempted = true;
    try {
      this.spawn();
      this.crashed = false;
    } catch {
      this.crashError = rejection;
    }
  }

  private dispatch(msg: HostMessage): void {
    this.worker.postMessage(msg);
  }

  private reply(msg: HostMessage): void {
    try {
      this.dispatch(msg);
    } catch {
      /* worker already terminated */
    }
  }

  private settle(id: number, settleWith: (entry: Pending) => void): void {
    const entry = this.calls.get(id);
    if (!entry) return;
    this.calls.delete(id);
    settleWith(entry);
  }

  private receive(msg: WorkerMessage): void {
    switch (msg.kind) {
      case "ready":
        this.booted = true;
        clearTimeout(this.bootTimer);
        this.resolveReady();
        break;
      case "result":
        this.settle(msg.id, (entry) => entry.resolve(msg.result as never));
        break;
      case "authState":
        this.settle(msg.id, (entry) => entry.resolve(msg.state as never));
        break;
      case "refreshed":
        this.settle(msg.id, (entry) => entry.resolve(msg.ok as never));
        break;
      case "accessToken":
        this.settle(msg.id, (entry) => entry.resolve(msg.token as never));
        break;
      case "void":
        this.settle(msg.id, (entry) => entry.resolve(undefined as never));
        break;
      case "failure":
        this.settle(msg.id, (entry) => entry.reject(new Error(msg.message)));
        break;
      case "authChanged":
        this.events.authChanged(msg.state);
        break;
      case "authFailure":
        callHook(this.options.onAuthFailure);
        break;
      case "log":
        if (this.options.onLog) callHook(this.options.onLog, msg.entry as never);
        else console.info("[api-client]", msg.entry);
        break;
      case "storage":
        void this.serveStorage(msg.id, msg.op, msg.tokens);
        break;
      case "csrf":
        void this.readCsrf().then((token) => this.reply({ kind: "csrfResult", id: msg.id, token }));
        break;
    }
  }

  /** Runs one storage operation for the worker. Always replies, so the worker never waits on a dead call. */
  private async serveStorage(id: number, op: "get" | "set" | "clear", tokens?: TokenPair): Promise<void> {
    let result: TokenPair | null = null;
    try {
      if (this.storage && op === "get") result = (await this.storage.get()) ?? null;
      else if (this.storage && op === "set" && tokens) await this.storage.set(tokens);
      else if (this.storage && op === "clear") await this.storage.clear();
    } catch {
      result = null;
    }
    this.reply({ kind: "storageResult", id, tokens: result });
  }

  /** One RPC round trip. An abort of `signal` is forwarded so the worker's fetch really stops. */
  async call<T>(build: (id: number) => HostMessage, signal?: AbortSignal): Promise<T> {
    await this.ready;
    if (this.destroyed) throw new Error("Client destroyed");
    if (this.crashed) throw this.crashError ?? new Error("The request worker is unavailable");
    const id = ++this.seq;

    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      this.calls.set(id, { resolve: resolve as never, reject });
      signal?.addEventListener("abort", () => this.reply({ kind: "abort", id, reason: reasonOf(signal.reason) }), {
        once: true,
      });
      this.dispatch(build(id));
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.bootTimer);
    this.reply({ kind: "destroy" });
    this.worker.terminate();
    for (const [, entry] of this.calls) entry.reject(new Error("Client destroyed"));
    this.calls.clear();
    // Calls still waiting for boot would otherwise hang forever (React StrictMode, HMR).
    this.resolveReady();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}
