import type { StorageKind, TokenPair, TokenStorage } from "../types";

/**
 * Token persistence adapters.
 *
 * Security note: `local` and `session` are readable by any script on the
 * origin, so they are vulnerable to XSS. `memory` (the default) and httpOnly
 * cookies set by your server are the safe options.
 */

/** In-memory only. Nothing survives a reload — the safest default. */
export class MemoryStorage implements TokenStorage {
  private tokens: TokenPair | null = null;

  get(): TokenPair | null {
    return this.tokens;
  }
  set(tokens: TokenPair): void {
    this.tokens = tokens;
  }
  clear(): void {
    this.tokens = null;
  }
}

/** Backs onto `localStorage` / `sessionStorage`. */
export class WebStorage implements TokenStorage {
  constructor(
    private key: string,
    private kind: "local" | "session",
  ) {}

  private get store(): Storage | null {
    try {
      const s = this.kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;
      // Touch it: Safari private mode throws on access.
      s?.getItem(this.key);
      return s ?? null;
    } catch {
      return null;
    }
  }

  get(): TokenPair | null {
    try {
      const raw = this.store?.getItem(this.key);
      return raw ? (JSON.parse(raw) as TokenPair) : null;
    } catch {
      return null;
    }
  }

  set(tokens: TokenPair): void {
    try {
      this.store?.setItem(this.key, JSON.stringify(tokens));
    } catch {
      /* quota exceeded */
    }
  }

  clear(): void {
    try {
      this.store?.removeItem(this.key);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Non-httpOnly cookie storage, for when tokens must survive a reload and be
 * readable by SSR. Uses `SameSite=Lax` and `Secure` on https.
 */
export class CookieStorage implements TokenStorage {
  constructor(
    private key: string,
    private days = 7,
  ) {}

  get(): TokenPair | null {
    if (typeof document === "undefined") return null;
    const match = document.cookie.match(
      new RegExp(`(?:^|;\\s*)${this.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`),
    );
    if (!match) return null;
    try {
      return JSON.parse(decodeURIComponent(match[1])) as TokenPair;
    } catch {
      return null;
    }
  }

  set(tokens: TokenPair): void {
    if (typeof document === "undefined") return;
    const expires = new Date(Date.now() + this.days * 86_400_000).toUTCString();
    const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
    document.cookie =
      `${this.key}=${encodeURIComponent(JSON.stringify(tokens))}` +
      `; Expires=${expires}; Path=/; SameSite=Lax${secure}`;
  }

  clear(): void {
    if (typeof document === "undefined") return;
    document.cookie = `${this.key}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; SameSite=Lax`;
  }
}

/** Resolves the `storage` option into a concrete adapter. */
export function resolveStorage(
  storage: StorageKind | TokenStorage | undefined,
  keyPrefix: string,
): TokenStorage {
  if (storage && typeof storage === "object") return storage;

  const key = `${keyPrefix}.tokens`;
  switch (storage) {
    case "local":
      return new WebStorage(key, "local");
    case "session":
      return new WebStorage(key, "session");
    case "cookie":
      return new CookieStorage(key);
    case "memory":
    default:
      return new MemoryStorage();
  }
}
