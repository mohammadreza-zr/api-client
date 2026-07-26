import type { ITokenStorage } from "./token-storage.interface";

export interface CookieStorageOptions {
  accessTokenExpireDays?: number;
  refreshTokenExpireDays?: number;
  secure?: boolean;
  /**
   * Provide your own cookie helpers (e.g. `cookies-next`).
   * If omitted, falls back to `document.cookie` on the client.
   */
  getCookie?: (name: string) => Promise<string | undefined> | string | undefined;
  setCookie?: (name: string, value: string, opts?: Record<string, unknown>) => Promise<void> | void;
  deleteCookie?: (name: string) => Promise<void> | void;
}

/**
 * Cookie-backed token storage.
 *
 * Works with `cookies-next` on the server **and** `document.cookie` on the client.
 * Pass your own helpers via `CookieStorageOptions` for full control.
 */
export class CookieTokenStorage implements ITokenStorage {
  private opts: Required<Pick<CookieStorageOptions, "accessTokenExpireDays" | "refreshTokenExpireDays" | "secure">> &
    CookieStorageOptions;

  constructor(opts: CookieStorageOptions = {}) {
    this.opts = {
      accessTokenExpireDays: 1,
      refreshTokenExpireDays: 7,
      secure:
        typeof process !== "undefined" && process.env?.NODE_ENV === "production",
      ...opts,
    };
  }

  // ── helpers ──────────────────────────────────────────────

  private async readCookie(name: string): Promise<string | undefined> {
    if (this.opts.getCookie) {
      const raw = await this.opts.getCookie(name);
      if (!raw) return undefined;
      try { return JSON.parse(raw); } catch { return raw; }
    }
    // browser fallback
    if (typeof document !== "undefined") {
      const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
      if (!match) return undefined;
      try { return JSON.parse(decodeURIComponent(match[1])); } catch { return decodeURIComponent(match[1]); }
    }
    return undefined;
  }

  private async writeCookie(name: string, value: string, days: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (this.opts.setCookie) {
      await this.opts.setCookie(name, serialized, {
        expires: new Date(Date.now() + days * 86_400_000),
        path: "/",
        secure: this.opts.secure,
      });
      return;
    }
    if (typeof document !== "undefined") {
      const expires = new Date(Date.now() + days * 86_400_000).toUTCString();
      document.cookie = `${name}=${encodeURIComponent(serialized)}; expires=${expires}; path=/;${this.opts.secure ? " Secure" : ""}`;
    }
  }

  private async removeCookie(name: string): Promise<void> {
    if (this.opts.deleteCookie) { await this.opts.deleteCookie(name); return; }
    if (typeof document !== "undefined") {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/;`;
    }
  }

  // ── ITokenStorage ────────────────────────────────────────

  getAccessToken() { return this.readCookie("access_token"); }
  setAccessToken(t: string) { return this.writeCookie("access_token", t, this.opts.accessTokenExpireDays); }
  getRefreshToken() { return this.readCookie("refresh_token"); }
  setRefreshToken(t: string) { return this.writeCookie("refresh_token", t, this.opts.refreshTokenExpireDays); }

  async clearTokens() {
    await this.removeCookie("access_token");
    await this.removeCookie("refresh_token");
  }
}