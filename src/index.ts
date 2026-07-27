/**
 * @mrzr/api-client
 *
 * A dependency-free, typed REST client with automatic token refresh,
 * Web Worker isolation and cross-tab auth sync. Works in every JS runtime.
 */

export { createClient } from "./client";
export type { ApiClient } from "./client";

export { ApiError } from "./types";
export type {
  AuthMode,
  AuthState,
  ClientOptions,
  HttpMethod,
  IRes,
  ListResponse,
  LogEntry,
  Ordering,
  Params,
  RequestConfig,
  StorageKind,
  TokenExtractor,
  TokenPair,
  TokenStorage,
} from "./types";

// Storage adapters, for custom persistence setups.
export { CookieStorage, MemoryStorage, WebStorage } from "./internal/storage";

// Small utilities that are genuinely useful outside the client.
export { buildQueryString } from "./internal/url";
export { getTokenExpiry, isTokenExpired } from "./internal/jwt";
