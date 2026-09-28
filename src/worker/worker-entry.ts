/// <reference lib="webworker" />

import { CoreClient } from "../internal/core-client";
import { CancelError } from "../internal/cancel";
import { redactTokens, tokenFieldNames } from "../internal/extract";
import type { HostMessage, SerializableOptions, WorkerMessage } from "./protocol";
import type { IRes, LogEntry, RequestConfig, TokenFieldMap, TokenPair, TokenStorage } from "../types";

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

// ── host bridge ──────────────────────────────────────────

let bridgeSeq = 0;
const bridgeWaiters = new Map<number, (value: unknown) => void>();

/**
 * Asks the main thread for something only it has (storage, cookies).
 * A host that never answers must not wedge the auth flow: after 5s the
 * answer is `fallback`.
 */
function askHost<T>(build: (id: number) => WorkerMessage, fallback: T): Promise<T> {
  const id = ++bridgeSeq;
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      if (bridgeWaiters.delete(id)) resolve(fallback);
    }, 5_000);
    bridgeWaiters.set(id, (value) => {
      clearTimeout(timer);
      resolve(value as T);
    });
    send(build(id));
  });
}

function answerHost(id: number, value: unknown): void {
  const waiter = bridgeWaiters.get(id);
  if (!waiter) return;
  bridgeWaiters.delete(id);
  waiter(value);
}

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
    return askHost<TokenPair | null>((id) => ({ kind: "storage", id, op, tokens }), null);
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

/** Messages that need an initialized client. */
type ClientMessage = Extract<
  HostMessage,
  { kind: "request" | "login" | "logout" | "setTokens" | "restoreSession" | "authState" | "refresh" | "accessToken" }
>;

const CLIENT_KINDS = new Set<HostMessage["kind"]>([
  "request",
  "login",
  "logout",
  "setTokens",
  "restoreSession",
  "authState",
  "refresh",
  "accessToken",
] satisfies ClientMessage["kind"][]);

const needsClient = (msg: HostMessage): msg is ClientMessage => CLIENT_KINDS.has(msg.kind);

/**
 * Nothing that crosses to the page may carry a token — worker mode's whole
 * promise. The session's live tokens are removed wherever a response echoes
 * them, and a call to the login or refresh endpoint also loses its token
 * fields: `api.post("/auth/refresh")` would otherwise mint a token for page code.
 */
function redact(active: CoreClient, result: IRes<unknown>, mintsTokens: boolean): void {
  const fields = mintsTokens ? tokenFieldNames(extractMapping) : new Set<string>();
  const tokens = active.liveTokens();
  result.data = redactTokens(result.data, fields, tokens);
  result.body = redactTokens(result.body, fields, tokens);
}

async function serve(active: CoreClient, msg: ClientMessage): Promise<void> {
  switch (msg.kind) {
    case "request": {
      const controller = new AbortController();
      aborters.set(msg.id, controller);
      const config = { ...msg.config, signal: controller.signal } as RequestConfig<unknown>;
      try {
        const result = await active.send(msg.method, msg.url, msg.body, config);
        redact(active, result, active.isAuthEndpoint(msg.url, config));
        send({ kind: "result", id: msg.id, result });
      } finally {
        aborters.delete(msg.id);
      }
      return;
    }
    case "login": {
      const result = await active.login(msg.body, msg.config as RequestConfig<unknown>);
      // The extractor already captured the tokens; the page gets the rest of the response.
      redact(active, result, true);
      return send({ kind: "result", id: msg.id, result });
    }
    case "logout":
      return send({ kind: "result", id: msg.id, result: await active.logout(msg.config as RequestConfig<unknown>) });
    case "setTokens":
      await active.setTokens(msg.tokens);
      return send({ kind: "void", id: msg.id });
    case "restoreSession":
      return send({ kind: "authState", id: msg.id, state: await active.restoreSession(msg.url) });
    case "authState":
      return send({ kind: "authState", id: msg.id, state: await active.getAuthState() });
    case "refresh":
      return send({ kind: "refreshed", id: msg.id, ok: await active.refresh() });
    case "accessToken":
      // CoreClient refuses unless the client was created with `exposeTokens: true`.
      return send({ kind: "accessToken", id: msg.id, token: await active.getAccessToken() });
  }
}

function init(options: SerializableOptions): void {
  extractMapping = options.extractTokens;
  // Persistent kinds are proxied to the host; memory stays local.
  const storage = (options.storage ?? "memory") === "memory" ? undefined : new HostStorage();
  const getCsrfToken = options.csrf
    ? () => askHost<string | undefined>((id) => ({ kind: "csrf", id }), undefined)
    : undefined;

  client = new CoreClient(
    {
      ...options,
      getCsrfToken,
      onAuthStateChanged: (state) => send({ kind: "authChanged", state }),
      onAuthFailure: () => send({ kind: "authFailure" }),
      onLog: (entry: LogEntry) => send({ kind: "log", entry }),
    },
    storage,
  );
  send({ kind: "ready" });
}

self.onmessage = async (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  if (!msg) return;

  try {
    if (needsClient(msg)) {
      if (!client) return send({ kind: "failure", id: msg.id, message: "Worker not initialized" });
      return await serve(client, msg);
    }
    switch (msg.kind) {
      case "init":
        return init(msg.options);
      case "storageResult":
        return answerHost(msg.id, msg.tokens);
      case "csrfResult":
        return answerHost(msg.id, msg.token);
      case "abort":
        // A CancelError, so the engine reports a flagged cancellation with its reason.
        aborters.get(msg.id)?.abort(new CancelError(msg.reason));
        aborters.delete(msg.id);
        return;
      case "destroy":
        client?.destroy();
        client = null;
        for (const controller of aborters.values()) controller.abort(new CancelError("client destroyed"));
        aborters.clear();
        return self.close();
    }
  } catch (error) {
    const message = (error as Error)?.message ?? "Worker error";
    if ("id" in msg && typeof msg.id === "number") send({ kind: "failure", id: msg.id, message });
  }
};
