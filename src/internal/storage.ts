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
/** Tokens are ASCII, which `encodeURIComponent` at most triples. */
const JSON_CHUNK_SIZE = 1200;
const CHUNKED_PREFIX = "chunks:";
/** Far above any real token pair; a planted `chunks:999999999` must not freeze the tab. */
const MAX_COOKIE_CHUNKS = 16;

/**
 * Non-httpOnly cookie storage, for when tokens must survive a reload and be
 * readable by SSR. Uses `SameSite=Lax` and `Secure` on https.
 *
 * A JWT pair easily outgrows one cookie, so large values are split across
 * `<key>.0`, `<key>.1`, … with `<key>` holding the chunk count.
 */
export class CookieStorage implements TokenStorage {
  private warnedTooLarge = false;

  constructor(
    private key: string,
    private days = 7,
  ) {}

  get(): TokenPair | null {
    const head = readCookie(this.key);
    if (!head) return null;
    let raw = head;
    if (head.startsWith(CHUNKED_PREFIX)) {
      const count = this.chunkCount();
      if (count === 0) return null;
      const parts: string[] = [];
      for (let i = 0; i < count; i++) {
        const part = readCookie(`${this.key}.${i}`);
        if (part === undefined) return null;
        parts.push(part);
      }
      raw = parts.join("");
    }
    try {
      return JSON.parse(raw) as TokenPair;
    } catch {
      return null;
    }
  }

  set(tokens: TokenPair): void {
    if (typeof document === "undefined") return;
    const expires = new Date(Date.now() + this.days * 86_400_000).toUTCString();
    const json = JSON.stringify(tokens);
    const whole = encodeURIComponent(json);
    const previous = this.chunkCount();

    if (whole.length <= COOKIE_CHUNK_SIZE) {
      this.write(this.key, whole, expires);
      this.removeChunks(0, previous);
      return;
    }
    // Slice before encoding, so no `%XX` escape is split across two cookies.
    const count = Math.ceil(json.length / JSON_CHUNK_SIZE);
    if (count > MAX_COOKIE_CHUNKS) {
      // Persistence errors are swallowed by design, so say it here once instead of losing the session silently.
      if (!this.warnedTooLarge) console.warn(`[api-client] tokens too large for CookieStorage (${json.length} chars); use storage: "local"`);
      this.warnedTooLarge = true;
      return;
    }
    for (let i = 0; i < count; i++) {
      const part = json.slice(i * JSON_CHUNK_SIZE, (i + 1) * JSON_CHUNK_SIZE);
      this.write(`${this.key}.${i}`, encodeURIComponent(part), expires);
    }
    this.removeChunks(count, previous);
    this.write(this.key, `${CHUNKED_PREFIX}${count}`, expires);
  }

  clear(): void {
    if (typeof document === "undefined") return;
    this.removeChunks(0, this.chunkCount());
    this.write(this.key, "", "Thu, 01 Jan 1970 00:00:00 GMT");
  }

  private chunkCount(): number {
    const head = readCookie(this.key);
    const count = head?.startsWith(CHUNKED_PREFIX) ? Number(head.slice(CHUNKED_PREFIX.length)) : 0;
    return Number.isInteger(count) && count > 0 && count <= MAX_COOKIE_CHUNKS ? count : 0;
  }

  private removeChunks(from: number, to: number): void {
    for (let i = from; i < to; i++) this.write(`${this.key}.${i}`, "", "Thu, 01 Jan 1970 00:00:00 GMT");
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
