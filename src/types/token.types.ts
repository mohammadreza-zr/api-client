export interface TokenPair {
  access: string;
  refresh: string;
}

/**
 * Called when a 401 is received.
 *
 * - **Header mode:** return the new access token, or `null` on failure.
 * - **Cookie mode:** call the refresh endpoint (the browser sends the
 *   httpOnly cookie automatically). Return `""` if the server only sets
 *   cookies, or the token if the response body includes it.
 *   Return `null` on failure.
 */
export interface RefreshTokenHandler {
  (currentRefreshToken: string | undefined): Promise<string | null>;
}

export type LogoutHandler = () => Promise<void> | void;