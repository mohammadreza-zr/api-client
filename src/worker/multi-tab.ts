import type { TabBroadcast } from "./protocol";

export type MultiTabEventHandler = (event: TabBroadcast) => void;

/**
 * Coordinates auth state across browser tabs via BroadcastChannel.
 *
 * - When one tab refreshes → others are notified.
 * - When one tab logs out → all tabs clear state.
 * - No tokens are ever broadcast. Only booleans and timestamps.
 */
export class MultiTabCoordinator {
  private channel: BroadcastChannel | null = null;
  private handlers: MultiTabEventHandler[] = [];
  readonly tabId: string;

  constructor(channelName = "fetchguard_auth") {
    this.tabId = Math.random().toString(36).slice(2);

    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(channelName);
      this.channel.onmessage = (event: MessageEvent<TabBroadcast>) => {
        if (event.data.tabId === this.tabId) return;
        this.handlers.forEach((h) => h(event.data));
      };
    }
  }

  /** Subscribe to cross-tab auth events. */
  onEvent(handler: MultiTabEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /** Broadcast that a refresh completed in this tab. */
  notifyRefreshCompleted(expiresAt: number) {
    this.broadcast({
      type: "REFRESH_COMPLETED",
      tabId: this.tabId,
      expiresAt,
      isAuthenticated: true,
    });
  }

  /** Broadcast that this tab logged out. */
  notifyLogout() {
    this.broadcast({ type: "LOGOUT", tabId: this.tabId });
  }

  /** Broadcast auth state for syncing. */
  syncAuthState(isAuthenticated: boolean, expiresAt: number | null) {
    this.broadcast({
      type: "AUTH_STATE_SYNC",
      tabId: this.tabId,
      isAuthenticated,
      expiresAt,
    });
  }

  private broadcast(msg: TabBroadcast) {
    this.channel?.postMessage(msg);
  }

  destroy() {
    this.channel?.close();
    this.channel = null;
    this.handlers = [];
  }
}