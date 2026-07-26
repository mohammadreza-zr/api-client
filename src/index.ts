export { createClient } from "./create-client";
export type { CreateClientOptions, FetchGuardClient } from "./create-client";

// For advanced users who want direct access:
export { APIClient } from "./client";
export { WorkerClient } from "./worker/worker-client";
export { MultiTabCoordinator } from "./worker/multi-tab";

// Types
export type {
  IRes,
  APIConfig,
  Params,
  HttpMethod,
  ListResponse,
  Ordering,
  TokenPair,
  RefreshTokenHandler,
  LogoutHandler,
} from "./types";

export type { APIClientOptions, AuthMode } from "./config/defaults";
export type { ITokenStorage } from "./storage/token-storage.interface";
export { MemoryTokenStorage } from "./storage/memory-storage";
export { CookieTokenStorage } from "./storage/cookie-storage";
export { IndexedDBTokenStorage } from "./storage/indexeddb-storage";

// Utils
export { buildQueryString } from "./utils/query-string";
export { applyUrlTemplate } from "./utils/url-template";
export { TokenManager } from "./core/token-manager";
export { RequestQueue } from "./core/request-queue";