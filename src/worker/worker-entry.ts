/// <reference lib="webworker" />

import { CoreClient } from "../internal/core-client";
import type { HostMessage, WorkerMessage } from "./protocol";
import type { LogEntry, RequestConfig } from "../types";

/**
 * Worker-side host.
 *
 * Tokens live only in this scope: they are never posted back to the main
 * thread, and no message handler can read them out. The main thread can ask
 * for auth *state* (booleans and timestamps) but never for the tokens.
 */
declare const self: DedicatedWorkerGlobalScope;

let client: CoreClient | null = null;
const aborters = new Map<number, AbortController>();

const send = (msg: WorkerMessage): void => self.postMessage(msg);

self.onmessage = async (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  if (!msg) return;

  try {
    switch (msg.kind) {
      case "init": {
        client = new CoreClient({
          ...msg.options,
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

      case "abort": {
        aborters.get(msg.id)?.abort();
        aborters.delete(msg.id);
        break;
      }

      case "login": {
        if (!client) return send({ kind: "failure", id: msg.id, message: "Worker not initialized" });
        const result = await client.login(msg.body, msg.config as RequestConfig<unknown>);
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
        for (const controller of aborters.values()) controller.abort();
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
