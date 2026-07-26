import type { ITokenStorage } from "../storage/token-storage.interface";
import type { RefreshTokenHandler, LogoutHandler } from "../types";
import { RequestQueue } from "./request-queue";

export interface TokenManagerOptions {
  storage: ITokenStorage;
  refreshHandler?: RefreshTokenHandler;
  onAuthFailure?: LogoutHandler;
}

export class TokenManager {
  readonly queue = new RequestQueue();

  private storage: ITokenStorage;
  private refreshHandler?: RefreshTokenHandler;
  private onAuthFailure?: LogoutHandler;

  constructor(opts: TokenManagerOptions) {
    this.storage = opts.storage;
    this.refreshHandler = opts.refreshHandler;
    this.onAuthFailure = opts.onAuthFailure;
  }

  async getAccessToken(): Promise<string | undefined> {
    return this.storage.getAccessToken();
  }

  async setAccessToken(token: string): Promise<void> {
    await this.storage.setAccessToken(token);
  }

  async getRefreshToken(): Promise<string | undefined> {
    return this.storage.getRefreshToken();
  }

  async setRefreshToken(token: string): Promise<void> {
    await this.storage.setRefreshToken(token);
  }

  async clearTokens(): Promise<void> {
    await this.storage.clearTokens();
  }

  /**
   * Refresh the access token.
   *
   * - Header mode: refreshHandler returns the new token string.
   * - Cookie mode: refreshHandler calls the endpoint (browser sends the
   *   httpOnly refresh cookie), server sets new httpOnly cookies in the
   *   response. Handler can return "" or the token if the body includes it.
   *
   * @returns new access token, or `null` if refresh failed.
   */
  async refresh(): Promise<string | null> {
    if (this.queue.isPaused) {
      return this.queue.waitForResume();
    }

    const waitPromise = this.queue.pause();

    try {
      if (!this.refreshHandler) {
        this.queue.resume(null);
        await this.handleAuthFailure();
        return null;
      }

      // In cookie mode the storage may not have a readable refresh token.
      // Pass whatever we have — the handler decides what to do.
      const refreshToken = await this.getRefreshToken();
      const newAccess = await this.refreshHandler(refreshToken);

      // newAccess can be:
      //   - a token string (header mode, or cookie mode where body has it)
      //   - "" empty string (cookie mode, server set httpOnly cookie)
      //   - null (refresh failed)

      if (newAccess === null) {
        this.queue.resume(null);
        await this.handleAuthFailure();
        return null;
      }

      // If we got a real token, store it (header mode)
      if (newAccess) {
        await this.setAccessToken(newAccess);
      }

      // Resume with the token (or "" for cookie mode)
      this.queue.resume(newAccess || "");
      return newAccess || "";
    } catch {
      this.queue.resume(null);
      await this.handleAuthFailure();
      return null;
    }
  }

  private async handleAuthFailure(): Promise<void> {
    await this.clearTokens();
    this.onAuthFailure?.();
  }
}