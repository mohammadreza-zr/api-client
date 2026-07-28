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
  CancelMatch,
  CancelOptions,
  CancelScope,
  CancelSelector,
  ClientOptions,
  HttpMethod,
  IRes,
  ListResponse,
  LogEntry,
  Ordering,
  Params,
  PendingRequest,
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

/**
 * Resolves the base URL the client would auto-detect. Exported for debugging:
 * an empty string means nothing was found and relative URLs will resolve
 * against the current origin.
 */
export { detectBaseUrl, BASE_URL_KEYS } from "./internal/env";
export { getTokenExpiry, isTokenExpired } from "./internal/jwt";
