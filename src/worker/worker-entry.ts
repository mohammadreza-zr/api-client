/// <reference lib="webworker" />

import { CoreClient } from "../internal/core-client";
import { CancelError } from "../internal/cancel";
import { stripTokenFields } from "../internal/extract";
import type { HostMessage, WorkerMessage } from "./protocol";
import type { LogEntry, RequestConfig, TokenFieldMap, TokenPair, TokenStorage } from "../types";

/**
 * Worker-side host.
 *
 * Tokens live only in this scope: they are never posted back to the main
 * thread, and no message handler can read them out. The main thread can ask
 * for auth *state* (booleans and timestamps) but never for the tokens.
 */
declare const self: DedicatedWorkerGlobalScope;

let client: CoreClient | null = null;
/** The declarative token map from `init`, so login results are stripped of custom key names too. */
let extractMapping: TokenFieldMap | undefined;
const aborters = new Map<number, AbortController>();

const send = (msg: WorkerMessage): void => self.postMessage(msg);

// ── storage bridge ───────────────────────────────────────

let storageSeq = 0;
const storageWaiters = new Map<number, (tokens: TokenPair | null) => void>();

/**
 * Persists through the main thread.
 *
 * `localStorage`, `sessionStorage` and `document.cookie` are Window APIs with
 * no worker equivalent, so a worker-side adapter would silently discard every
 * write — which is exactly the bug this replaces. The host owns the actual
 * storage; this just forwards the three operations to it.
 *
 * Only used for explicitly persistent adapters. `"memory"` stays in the worker
 * so the default configuration keeps tokens off the main thread entirely.
 */
class HostStorage implements TokenStorage {
  private ask(op: "get" | "set" | "clear", tokens?: TokenPair): Promise<TokenPair | null> {
    const id = ++storageSeq;
    return new Promise<TokenPair | null>((resolve) => {
      // A host that never answers must not wedge the auth flow forever.
      const timer = setTimeout(() => {
        if (storageWaiters.delete(id)) resolve(null);
      }, 5_000);

      storageWaiters.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });

      send({ kind: "storage", id, op, tokens });
    });
  }

  get(): Promise<TokenPair | null> {
    return this.ask("get");
  }

  async set(tokens: TokenPair): Promise<void> {
    await this.ask("set", tokens);
  }

  async clear(): Promise<void> {
    await this.ask("clear");
  }
}

self.onmessage = async (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  if (!msg) return;

  try {
    switch (msg.kind) {
      case "init": {
        extractMapping = msg.options.extractTokens;
        // Persistent kinds are proxied to the host; memory stays local.
        const kind = msg.options.storage ?? "memory";
        const storage = kind === "memory" ? undefined : new HostStorage();

        client = new CoreClient({
          ...msg.options,
          storage,
          multiTab: msg.options.multiTab,
          onAuthStateChanged: (state) => send({ kind: "authChanged", state }),
          onAuthFailure: () => send({ kind: "authFailure" }),
          onLog: (entry: LogEntry) => send({ kind: "log", entry }),
        });
        send({ kind: "ready" });
        break;
      }

      case "request": {
        if (!client) return send({ kind: "failure", id: msg.id, message: "Worker not initialized" });

        const controller = new AbortController();
        aborters.set(msg.id, controller);

        const config = { ...(msg.config ?? {}), signal: controller.signal } as RequestConfig<unknown>;

        try {
          const result = await client[
            msg.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete"
          ](msg.url as never, ...(bodyArgs(msg.method, msg.body, config) as never[]));
          send({ kind: "result", id: msg.id, result: result as never });
        } finally {
          aborters.delete(msg.id);
        }
        break;
      }

      case "storageResult": {
        const waiter = storageWaiters.get(msg.id);
        if (waiter) {
          storageWaiters.delete(msg.id);
          waiter(msg.tokens);
        }
        break;
      }

      case "abort": {
        // Abort with a CancelError so the engine reports it as a cancellation
        // — flagged, with the reason — rather than a bare abort.
        aborters.get(msg.id)?.abort(new CancelError(msg.reason));
        aborters.delete(msg.id);
        break;
      }

      case "login": {
        if (!client) return send({ kind: "failure", id: msg.id, message: "Worker not initialized" });
        const result = await client.login(msg.body, msg.config as RequestConfig<unknown>);
        /*
         * The login response usually contains the tokens themselves, and the
         * whole point of worker mode is that tokens never reach the main
         * thread — not even as a side effect of `api.login()` resolving.
         * Strip them before the result crosses the boundary; the extractor
         * has already captured them into the worker's closure. The mapping is
         * passed along so custom key names are stripped too.
         */
        result.data = stripTokenFields(result.data, extractMapping);
        send({ kind: "result", id: msg.id, result });
        break;
      }

      case "logout": {
        if (!client) return send({ kind: "failure", id: msg.id, message: "Worker not initialized" });
        const result = await client.logout(msg.config as RequestConfig<unknown>);
        send({ kind: "result", id: msg.id, result });
        break;
      }

      case "setTokens": {
        if (!client) return send({ kind: "failure", id: msg.id, message: "Worker not initialized" });
        await client.setTokens(msg.tokens);
        send({ kind: "void", id: msg.id });
        break;
      }

      case "restoreSession": {
        if (!client) return send({ kind: "failure", id: msg.id, message: "Worker not initialized" });
        send({ kind: "authState", id: msg.id, state: await client.restoreSession(msg.url) });
        break;
      }

      case "authState": {
        if (!client) return send({ kind: "failure", id: msg.id, message: "Worker not initialized" });
        send({ kind: "authState", id: msg.id, state: await client.getAuthState() });
        break;
      }

      case "refresh": {
        if (!client) return send({ kind: "failure", id: msg.id, message: "Worker not initialized" });
        const token = await client.refresh();
        send({ kind: "refreshed", id: msg.id, ok: token !== null });
        break;
      }

      case "destroy": {
        client?.destroy();
        client = null;
        for (const controller of aborters.values()) {
          controller.abort(new CancelError("client destroyed"));
        }
        aborters.clear();
        self.close();
        break;
      }
    }
  } catch (error) {
    const message = (error as Error)?.message ?? "Worker error";
    if ("id" in msg && typeof msg.id === "number") {
      send({ kind: "failure", id: msg.id, message });
    }
  }
};

/** GET and DELETE take `(url, config)`; the others take `(url, body, config)`. */
function bodyArgs(method: string, body: unknown, config: RequestConfig<unknown>): unknown[] {
  return method === "GET" || method === "DELETE" ? [config] : [body, config];
}
