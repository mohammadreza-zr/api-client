import type { ClientOptions, StorageKind, TokenPair, TokenStorage } from "../types";
import { readCookie } from "./cookie";

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

/** Browsers drop a cookie over ~4096 bytes (name and attributes included) without an error. */
const COOKIE_CHUNK_SIZE = 3800;
/**
 * ~19 KB: already past what many servers accept in one `Cookie` header, so
 * refusing beyond it is kinder than breaking every request. The cap also
 * keeps a planted head cookie from making the tab loop.
 */
const MAX_COOKIE_CHUNKS = 5;
const CHUNKED_HEAD = /^chunks:(\d):([a-z0-9]{1,16})$/;
const EXPIRED = "Thu, 01 Jan 1970 00:00:00 GMT";

interface ChunkLayout {
  count: number;
  version: string;
}

/** Splits encoded text into cookie-sized pieces, never inside a `%XX` escape. */
function splitEncoded(encoded: string): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < encoded.length; ) {
    let end = Math.min(at + COOKIE_CHUNK_SIZE, encoded.length);
    const escape = encoded.lastIndexOf("%", end - 1);
    if (escape > end - 3 && end < encoded.length) end = escape;
    pieces.push(encoded.slice(at, end));
    at = end;
  }
  return pieces;
}

/**
 * Non-httpOnly cookie storage, for when tokens must survive a reload and be
 * readable by SSR. Uses `SameSite=Lax` and `Secure` on https.
 *
 * A JWT pair easily outgrows one cookie, so a large value is split across
 * `<key>.<version>.0`, `<key>.<version>.1`, … and `<key>` holds
 * `chunks:<count>:<version>`. Each write uses a fresh version and flips the
 * head last, so another tab reading mid-write sees the old value or the new
 * one, never a mix.
 */
export class CookieStorage implements TokenStorage {
  private warnedTooLarge = false;

  constructor(
    private key: string,
    private days = 7,
  ) {}

  get(): TokenPair | null {
    const layout = this.layout();
    let raw: string | undefined;
    if (layout) {
      const pieces: string[] = [];
      for (let i = 0; i < layout.count; i++) {
        const piece = readCookie(this.chunkName(layout.version, i), false);
        if (piece === undefined) return null;
        pieces.push(piece);
      }
      raw = pieces.join("");
    } else {
      raw = readCookie(this.key, false);
    }
    if (!raw) return null;
    try {
      return JSON.parse(decodeURIComponent(raw)) as TokenPair;
    } catch {
      return null;
    }
  }

  set(tokens: TokenPair): void {
    if (typeof document === "undefined") return;
    const expires = new Date(Date.now() + this.days * 86_400_000).toUTCString();
    const encoded = encodeURIComponent(JSON.stringify(tokens));
    const previous = this.layout();

    if (encoded.length <= COOKIE_CHUNK_SIZE) {
      this.write(this.key, encoded, expires);
    } else {
      const pieces = splitEncoded(encoded);
      if (pieces.length > MAX_COOKIE_CHUNKS) {
        // Persistence errors are swallowed by design, so say it here once instead of losing the session silently.
        if (!this.warnedTooLarge) console.warn(`[api-client] tokens too large for CookieStorage (${encoded.length} chars); use storage: "local"`);
        this.warnedTooLarge = true;
        return;
      }
      const version = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      pieces.forEach((piece, i) => this.write(this.chunkName(version, i), piece, expires));
      this.write(this.key, `chunks:${pieces.length}:${version}`, expires);
    }
    if (previous) this.removeChunks(previous);
  }

  clear(): void {
    if (typeof document === "undefined") return;
    const previous = this.layout();
    this.write(this.key, "", EXPIRED);
    if (previous) this.removeChunks(previous);
  }

  private chunkName(version: string, index: number): string {
    return `${this.key}.${version}.${index}`;
  }

  private layout(): ChunkLayout | null {
    const match = readCookie(this.key, false)?.match(CHUNKED_HEAD);
    const count = match ? Number(match[1]) : 0;
    return match && count > 0 && count <= MAX_COOKIE_CHUNKS ? { count, version: match[2] } : null;
  }

  private removeChunks({ count, version }: ChunkLayout): void {
    for (let i = 0; i < count; i++) this.write(this.chunkName(version, i), "", EXPIRED);
  }

  private write(name: string, value: string, expires: string): void {
    const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${name}=${value}; Expires=${expires}; Path=/; SameSite=Lax${secure}`;
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

/** The adapter a main-thread client persists through; none in cookie mode, where the server holds the session. */
export function storageFor(options: ClientOptions): TokenStorage | undefined {
  if (options.authMode === "cookie") return undefined;
  return resolveStorage(options.storage ?? "memory", options.storageKey ?? "apiclient");
}

/**
 * Whether every tab of the origin sees one session: the server's cookie, or
 * local storage and cookies. Memory and sessionStorage are per tab.
 */
export function sharesSession(options: ClientOptions): boolean {
  const { authMode, storage } = options;
  return authMode === "cookie" || typeof storage === "object" || storage === "local" || storage === "cookie";
}
