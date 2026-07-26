import { hasBroadcastChannel, isServer } from "./env";

/** Cross-tab messages. Tokens are never included. */
export type TabMessage =
  | { type: "refreshed"; tabId: string; expiresAt: number | null }
  | { type: "logout"; tabId: string }
  | { type: "login"; tabId: string; expiresAt: number | null }
  | { type: "claim"; tabId: string; at: number };

/**
 * Keeps auth state aligned across tabs.
 *
 * Also provides best-effort leader election so that when several tabs wake up
 * at once (e.g. after sleep) only one of them drives the token refresh.
 */
export class TabSync {
  private channel: BroadcastChannel | null = null;
  private handlers = new Set<(msg: TabMessage) => void>();
  readonly tabId: string;

  /** Lowest known claim timestamp wins; ties break on tabId. */
  private leaderClaim: { tabId: string; at: number };

  constructor(channelName: string, enabled = true) {
    this.tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.leaderClaim = { tabId: this.tabId, at: Date.now() };

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

        if (msg.type === "claim") {
          if (msg.at < this.leaderClaim.at || (msg.at === this.leaderClaim.at && msg.tabId < this.leaderClaim.tabId)) {
            this.leaderClaim = { tabId: msg.tabId, at: msg.at };
          }
          return;
        }

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
   * Announces intent to refresh and reports whether this tab should lead.
   * Without BroadcastChannel every tab leads (single-tab behaviour).
   */
  claimLeadership(): boolean {
    if (!this.channel) return true;
    this.leaderClaim = { tabId: this.tabId, at: Date.now() };
    this.post({ type: "claim", tabId: this.tabId, at: this.leaderClaim.at });
    return this.leaderClaim.tabId === this.tabId;
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
