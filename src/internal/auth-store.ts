import type { AuthState, TokenPair, TokenStorage } from "../types";
import { getTokenExpiry } from "./jwt";

/**
 * Owns the tokens and serializes refreshes.
 *
 * Replaces the original 250ms `while (isPending)` polling loop with a single
 * shared promise: N concurrent 401s trigger exactly one refresh call and all
 * of them await the same result.
 */
export class AuthStore {
  private access: string | undefined;
  private refresh: string | undefined;
  private expiry: number | null = null;
  private user: unknown;

  /**
   * Cookie mode has no readable token, so authentication is tracked as an
   * explicit flag: set on a successful login/refresh, cleared on logout or a
   * failed refresh. In header mode this stays `false` and presence of an
   * access token decides instead.
   */
  private session = false;

  /**
   * Bumped whenever the session is replaced or ended. A refresh that started
   * under an older generation must not write its result back: that would
   * resurrect a session the user just logged out of.
   */
  private sessionGeneration = 0;

  private inFlight: Promise<unknown> | null = null;
  private listeners = new Set<(state: AuthState) => void>();
  /** The most recent persist, so callers can await durability. */
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private storage?: TokenStorage) {}

  /** Rehydrate from persistent storage, if one is configured. */
  async hydrate(): Promise<void> {
    const stored = await this.readStored();
    if (stored) this.apply(stored, false);
  }

  /** The persisted tokens, without applying them. Corrupt storage reads as empty. */
  async readStored(): Promise<TokenPair | null> {
    if (!this.storage) return null;
    try {
      return (await this.storage.get()) ?? null;
    } catch {
      return null;
    }
  }

  get generation(): number {
    return this.sessionGeneration;
  }

  /** Whether this store holds anything that could authenticate a request. */
  get hasCredentials(): boolean {
    return this.session || Boolean(this.access) || Boolean(this.refresh);
  }

  // ── state ──────────────────────────────────────────────

  get accessToken(): string | undefined {
    return this.access;
  }

  get refreshToken(): string | undefined {
    return this.refresh;
  }

  get expiresAt(): number | null {
    return this.expiry;
  }

  get state(): AuthState {
    return {
      // An expired access token with a refresh token is still a live session:
      // the next request refreshes silently, so the app must not redirect to login.
      isAuthenticated: this.session || Boolean(this.refresh) || (Boolean(this.access) && !this.isExpired()),
      expiresAt: this.expiry,
      user: this.user,
    };
  }

  /**
   * Marks the session active without a token, for httpOnly cookie mode.
   * The cookie itself is invisible to JS, so the server's response is the
   * only evidence we get that a session exists.
   */
  markSession(active: boolean): void {
    if (this.session === active) return;
    this.session = active;
    this.emit();
  }

  get hasSession(): boolean {
    return this.session;
  }

  isExpired(skewMs = 0): boolean {
    if (this.expiry === null) return false; // opaque token → server decides
    return Date.now() + skewMs >= this.expiry;
  }

  setUser(user: unknown): void {
    this.user = user;
    this.emit();
  }

  /**
   * Merges a token pair. Expiry is derived from the JWT when not supplied; a
   * new opaque token has no known expiry, so it never inherits the old one.
   */
  apply(tokens: TokenPair, persist = true): void {
    if (tokens.refreshToken !== undefined) this.refresh = tokens.refreshToken;
    if (tokens.accessToken !== undefined) {
      this.access = tokens.accessToken;
      this.expiry = tokens.expiresAt ?? getTokenExpiry(tokens.accessToken);
    } else if (tokens.expiresAt !== undefined) {
      this.expiry = tokens.expiresAt;
    }

    if (persist) this.pendingWrite = this.persist();
    this.emit();
  }

  /**
   * Starts a new session: nothing from the previous one survives. A login
   * response without a refresh token must not leave the last user's in place.
   */
  replace(tokens: TokenPair): void {
    this.sessionGeneration++;
    this.access = undefined;
    this.refresh = undefined;
    this.expiry = null;
    this.user = undefined;
    this.apply(tokens);
  }

  /**
   * Resolves once the last write has actually landed.
   *
   * Persisting is fire-and-forget so requests are never blocked on storage,
   * but `setTokens` and `login` must not resolve before the tokens are durable
   * — otherwise an immediate reload races the write and loses the session.
   */
  async flush(): Promise<void> {
    await this.pendingWrite;
  }

  /**
   * `setTokens()` semantics: a key given as `undefined` clears that token,
   * an omitted key keeps it. Extractor results can't use this — they always
   * carry both keys — so they go through `apply` / `replace` instead.
   */
  seed(tokens: TokenPair): void {
    this.sessionGeneration++;
    if ("accessToken" in tokens && tokens.accessToken === undefined) {
      this.access = undefined;
      this.expiry = null;
    }
    if ("refreshToken" in tokens && tokens.refreshToken === undefined) this.refresh = undefined;
    this.apply(tokens);
  }

  clear(persist = true): void {
    this.sessionGeneration++;
    this.access = undefined;
    this.refresh = undefined;
    this.expiry = null;
    this.user = undefined;
    this.session = false;
    if (persist && this.storage) {
      this.pendingWrite = Promise.resolve(this.storage.clear()).catch(() => {});
    }
    this.emit();
  }

  private async persist(): Promise<void> {
    if (!this.storage) return;
    try {
      await this.storage.set({
        accessToken: this.access,
        refreshToken: this.refresh,
        expiresAt: this.expiry ?? undefined,
      });
    } catch {
      /* quota / disabled storage is not fatal */
    }
  }

  // ── refresh de-duplication ─────────────────────────────

  get isRefreshing(): boolean {
    return this.inFlight !== null;
  }

  /**
   * Runs `task` as the single in-flight refresh.
   * Concurrent callers await the same promise instead of stampeding the server.
   */
  coalesceRefresh<T>(task: () => Promise<T>): Promise<T> {
    if (this.inFlight) return this.inFlight as Promise<T>;

    this.inFlight = task().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight as Promise<T>;
  }

  // ── observers ──────────────────────────────────────────

  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    const snapshot = this.state;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* a bad listener must not break auth */
      }
    }
  }
}
