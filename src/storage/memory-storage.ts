import type { ITokenStorage } from "./token-storage.interface";

/** Simple in-memory storage (useful for tests or non-browser environments). */
export class MemoryTokenStorage implements ITokenStorage {
  private access: string | undefined;
  private refresh: string | undefined;

  getAccessToken() { return this.access; }
  setAccessToken(t: string) { this.access = t; }
  getRefreshToken() { return this.refresh; }
  setRefreshToken(t: string) { this.refresh = t; }
  clearTokens() { this.access = undefined; this.refresh = undefined; }
}