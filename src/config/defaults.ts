import type { APIConfig } from "../types";

export type AuthMode = "header" | "cookie";

export interface APIClientOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  timeout?: number;
  refreshTokenUrl?: string;
  logoutUrl?: string;
  accessTokenExpireDays?: number;
  refreshTokenExpireDays?: number;
  cookieSecure?: boolean;
  toast?: { error: (msg: string) => void };
  onAuthFailure?: () => void;

  /**
   * How authentication is sent to the server.
   *
   * - `"header"` (default): reads the token from storage and sets
   *   `Authorization: Bearer <token>`.
   *
   * - `"cookie"`: the browser sends httpOnly cookies automatically.
   *   No Authorization header is set. `credentials: "include"` is
   *   added to every fetch call so cookies work cross-origin too.
   */
  authMode?: AuthMode;

  /**
   * The `credentials` value for fetch.
   * Default: `"same-origin"` for header mode, `"include"` for cookie mode.
   */
  credentials?: RequestCredentials;
}

export const DEFAULT_OPTIONS: Required<
  Pick<
    APIClientOptions,
    "timeout" | "refreshTokenUrl" | "logoutUrl" | "accessTokenExpireDays" | "refreshTokenExpireDays"
  >
> = {
  timeout: 30_000,
  refreshTokenUrl: "api/v1/auth/users/token/jwt/refresh/",
  logoutUrl: "api/v1/auth/users/token/logout/",
  accessTokenExpireDays: 1,
  refreshTokenExpireDays: 7,
};

export const DEFAULT_CONFIG: APIConfig<any> = {
  refreshTokenCheck: true,
  stringifyBody: true,
};