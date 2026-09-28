import { hasBroadcastChannel, isServer } from "./env";

/** Cross-tab messages. Tokens are never included. */
export type TabMessage =
  | { type: "refreshed"; tabId: string; expiresAt: number | null }
  | { type: "logout"; tabId: string }
  | { type: "login"; tabId: string; expiresAt: number | null };

interface LockManagerLike {
  request<T>(name: string, task: () => Promise<T>): Promise<T>;
}

/**
 * Keeps auth state aligned across tabs, and serializes their token refreshes
 * so a rotating refresh token is never spent twice.
 */
export class TabSync {
  private channel: BroadcastChannel | null = null;
  private handlers = new Set<(msg: TabMessage) => void>();
  readonly tabId: string;
  private lockName: string;

  constructor(channelName: string, enabled = true) {
    this.tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.lockName = `${channelName}.refresh`;

    // Never open a channel on the server: there are no other tabs to sync
    // with, and Node's BroadcastChannel is a ref'd handle that would keep the
    // process alive forever (hanging SSR renders, CLIs and test runners).
    if (!enabled || isServer() || !hasBroadcastChannel()) return;

    try {
      this.channel = new BroadcastChannel(channelName);
      // Belt and braces for non-browser runtimes that still expose the API.
      (this.channel as unknown as { unref?: () => void }).unref?.();
      this.channel.onmessage = (event: MessageEvent<TabMessage>) => {
        const msg = event.data;
        if (!msg || msg.tabId === this.tabId) return;
        for (const handler of this.handlers) {
          try {
            handler(msg);
          } catch {
            /* one bad listener must not break sync */
          }
        }
      };
    } catch {
      this.channel = null;
    }
  }

  get enabled(): boolean {
    return this.channel !== null;
  }

  post(msg: TabMessage): void {
    try {
      this.channel?.postMessage(msg);
    } catch {
      /* channel closed */
    }
  }

  on(handler: (msg: TabMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Runs `task` while holding a lock shared by every tab of this origin
   * (Web Locks API, available in windows and workers). Where the API is
   * missing, or sync is off, the task simply runs.
   */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
    if (!this.channel || typeof locks?.request !== "function") return task();
    return locks.request(this.lockName, task);
  }

  destroy(): void {
    this.handlers.clear();
    try {
      this.channel?.close();
    } catch {
      /* already closed */
    }
    this.channel = null;
  }
}
