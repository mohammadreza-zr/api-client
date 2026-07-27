import type { AuthState, ClientOptions, HttpMethod, IRes, RequestConfig, TokenPair } from "../types";

/**
 * Worker wire protocol.
 *
 * Config is structured-cloned, so function options (`beforeFunc`, `afterFunc`,
 * `beforeSelectOptions`) cannot cross the boundary. The host strips them and
 * re-applies them to the result on the main thread, which keeps worker mode
 * behaviourally identical to main-thread mode.
 */

/** Client options minus everything that is a function or otherwise unclonable. */
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
> & { storage?: Exclude<ClientOptions["storage"], object> };

/** Request config minus the function hooks. */
export type SerializableConfig = Omit<
  RequestConfig<unknown>,
  "beforeFunc" | "afterFunc" | "beforeSelectOptions" | "signal"
>;

export type HostMessage =
  | { kind: "init"; options: SerializableOptions }
  | { kind: "request"; id: number; method: HttpMethod; url: string; body?: unknown; config?: SerializableConfig }
  | { kind: "abort"; id: number }
  | { kind: "login"; id: number; body: unknown; config?: SerializableConfig }
  | { kind: "logout"; id: number; config?: SerializableConfig }
  | { kind: "setTokens"; id: number; tokens: TokenPair }
  | { kind: "authState"; id: number }
  | { kind: "refresh"; id: number }
  | { kind: "destroy" };

export type WorkerMessage =
  | { kind: "ready" }
  | { kind: "result"; id: number; result: IRes<unknown> }
  | { kind: "authState"; id: number; state: AuthState }
  | { kind: "refreshed"; id: number; ok: boolean }
  | { kind: "void"; id: number }
  | { kind: "failure"; id: number; message: string }
  | { kind: "authChanged"; state: AuthState }
  | { kind: "authFailure" }
  | { kind: "log"; entry: unknown };
