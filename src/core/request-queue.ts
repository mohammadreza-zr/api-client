/**
 * A promise-based queue that pauses callers while a token refresh is in-flight.
 *
 * ```
 * Request A → 401 → queue.pause() → refresh token → queue.resume(newToken)
 * Request B → 401 → queue.waitForResume()  ←──────────────────────────────┘
 * Request C → 401 → queue.waitForResume()  ←──────────────────────────────┘
 * ```
 *
 * No polling. No while-loops. Just a single shared promise.
 */
export class RequestQueue {
  private _paused = false;
  private _resumePromise: Promise<string | null> | null = null;
  private _resolve!: (token: string | null) => void;

  /** True while a refresh is in progress. */
  get isPaused(): boolean {
    return this._paused;
  }

  /**
   * Pause the queue. Returns a promise that **all** waiting callers will share.
   * Call this only once (the first 401).
   */
  pause(): Promise<string | null> {
    if (!this._paused) {
      this._paused = true;
      this._resumePromise = new Promise<string | null>((resolve) => {
        this._resolve = resolve;
      });
    }
    return this._resumePromise!;
  }

  /**
   * Wait until the queue is resumed.
   * If the queue is not paused, resolves immediately with `null`.
   */
  async waitForResume(): Promise<string | null> {
    if (!this._paused || !this._resumePromise) return null;
    return this._resumePromise;
  }

  /**
   * Resume all waiting requests with the new access token (or `null` on failure).
   */
  resume(newAccessToken: string | null): void {
    this._paused = false;
    this._resolve(newAccessToken);
    this._resumePromise = null;
  }
}