/**
 * Abstract token storage.
 * Implement this to plug in cookies, localStorage, SecureStore, etc.
 */
export interface ITokenStorage {
  getAccessToken(): Promise<string | undefined> | string | undefined;
  setAccessToken(token: string): Promise<void> | void;
  getRefreshToken(): Promise<string | undefined> | string | undefined;
  setRefreshToken(token: string): Promise<void> | void;
  clearTokens(): Promise<void> | void;
}