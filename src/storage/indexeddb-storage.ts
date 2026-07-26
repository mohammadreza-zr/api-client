import type { ITokenStorage } from "./token-storage.interface";

const DB_NAME = "fetchguard_auth";
const STORE_NAME = "tokens";
const KEY = "session";

/**
 * IndexedDB-backed storage for the refresh token.
 * Used in "body provider" mode where the refresh token is NOT httpOnly.
 *
 * The access token is NEVER stored here — it lives only in the worker closure.
 */
export class IndexedDBTokenStorage implements ITokenStorage {
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = this.openDB();
  }

  private openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async get(key: string): Promise<string | undefined> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? undefined);
      req.onerror = () => reject(req.error);
    });
  }

  private async set(key: string, value: string): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private async remove(key: string): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // ── ITokenStorage ────────────────────────────────────────

  // Access token is NOT persisted (lives in worker closure only)
  getAccessToken() { return undefined; }
  setAccessToken(_token: string) { /* no-op: worker owns it */ }

  // Refresh token IS persisted for session continuity
  async getRefreshToken() { return this.get(`${KEY}_refresh`); }
  async setRefreshToken(token: string) { await this.set(`${KEY}_refresh`, token); }

  async clearTokens() {
    await this.remove(`${KEY}_refresh`);
  }
}