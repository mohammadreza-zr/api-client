import type {
  AuthState,
  ClientOptions,
  HttpMethod,
  IRes,
  RefreshBodyConfig,
  RequestConfig,
  TokenFieldMap,
  TokenPair,
} from "../types";

/**
 * Worker wire protocol.
 *
 * Config is structured-cloned, so function options (`beforeFunc`, `afterFunc`,
 * `beforeSelectOptions`) cannot cross the boundary. The host strips them and
 * re-applies them to the result on the main thread, which keeps worker mode
 * behaviourally identical to main-thread mode.
 */

/**
 * Client options minus everything that is a function or otherwise unclonable.
 *
 * `extractTokens` / `buildRefreshBody` are forwarded in their declarative
 * forms only — the function forms disable worker mode entirely, so a function
 * never reaches this type.
 */
export type SerializableOptions = Omit<
  ClientOptions,
  | "storage"
  | "extractTokens"
  | "buildRefreshBody"
  | "onAuthStateChanged"
  | "onAuthFailure"
  | "onError"
  | "onLog"
  | "worker"
  | "getCsrfToken"
  /*
   * Cancellation is host-side. The host owns the registry so `api.cancel()`
   * stays synchronous, and forwards each cancellation as an `abort` message.
   * Sending the option across too would duplicate the bookkeeping in a scope
   * that can never be queried.
   */
  | "cancel"
> & {
  storage?: Exclude<ClientOptions["storage"], object>;
  /** Only the declarative form can cross; a function extractor disables worker mode. */
  extractTokens?: TokenFieldMap;
  /** Only the declarative form can cross; a function builder disables worker mode. */
  buildRefreshBody?: RefreshBodyConfig;
};

/**
 * Request config minus the function hooks.
 *
 * Cancellation metadata is stripped too: the registry lives on the host, so
 * the worker would only duplicate bookkeeping it can never be asked about.
 * The host translates a cancellation into an `abort` message instead.
 */
export type SerializableConfig = Omit<
  RequestConfig<unknown>,
  | "beforeFunc"
  | "afterFunc"
  | "beforeSelectOptions"
  | "signal"
  | "cancelable"
  | "cancelKey"
  | "cancelGroup"
  | "takeLatest"
  | "throwOnCancel"
>;

export type HostMessage =
  | { kind: "init"; options: SerializableOptions }
  | { kind: "request"; id: number; method: HttpMethod; url: string; body?: unknown; config?: SerializableConfig }
  /** `reason` is carried so the worker can report *why* it was canceled. */
  | { kind: "abort"; id: number; reason?: string }
  | { kind: "login"; id: number; body: unknown; config?: SerializableConfig }
  | { kind: "logout"; id: number; config?: SerializableConfig }
  | { kind: "setTokens"; id: number; tokens: TokenPair }
  | { kind: "authState"; id: number }
  | { kind: "refresh"; id: number }
  | { kind: "restoreSession"; id: number; url?: string }
  | { kind: "destroy" }
  /** Reply to a worker-initiated storage read/write. */
  | { kind: "storageResult"; id: number; tokens: TokenPair | null };

export type WorkerMessage =
  | { kind: "ready" }
  | { kind: "result"; id: number; result: IRes<unknown> }
  | { kind: "authState"; id: number; state: AuthState }
  | { kind: "refreshed"; id: number; ok: boolean }
  | { kind: "void"; id: number }
  | { kind: "failure"; id: number; message: string }
  | { kind: "authChanged"; state: AuthState }
  | { kind: "authFailure" }
  | { kind: "log"; entry: unknown }
  /**
   * Persistence request, proxied to the main thread.
   *
   * `localStorage`, `sessionStorage` and `document.cookie` are Window APIs and
   * simply do not exist in a worker scope, so the worker cannot persist tokens
   * itself. It asks the host to do it instead. Only reaches the host for
   * explicitly persistent adapters — `"memory"` never leaves the worker.
   */
  | { kind: "storage"; id: number; op: "get" | "set" | "clear"; tokens?: TokenPair };
