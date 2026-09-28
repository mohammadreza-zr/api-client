import type { AuthMode, TokenExtractor } from "../types";
import type { AuthStore } from "./auth-store";
import type { TabSync } from "./broadcast";
import type { CsrfReader } from "./cookie";

export interface RefreshContext {
  auth: AuthStore;
  tabs: TabSync;
  url: string;
  authMode: AuthMode;
  credentials: RequestCredentials;
  timeout: number;
  defaultHeaders: Record<string, string>;
  /** Whether tabs share one session (cookie mode or shared storage). */
  sharedSession: boolean;
  extractTokens: TokenExtractor;
  buildRefreshBody: (refreshToken?: string) => unknown;
  readCsrf: CsrfReader;
  csrfHeaderName: string;
  /** When a sibling tab last announced a successful refresh (epoch ms). */
  siblingRefreshedAt(): number;
  /** The server rejected the session: end it. */
  reject(): void;
}

type Outcome = "ok" | "rejected" | "failed";

/**
 * Whether another tab already refreshed while this one waited for the lock.
 * With a rotating refresh token, sending the old one again would be read by
 * the server as token reuse and revoke the whole session.
 */
async function adoptSiblingRefresh(ctx: RefreshContext, startedWith: string | undefined, queuedAt: number): Promise<boolean> {
  if (!ctx.sharedSession) return false;
  if (ctx.authMode === "cookie") {
    if (ctx.siblingRefreshedAt() < queuedAt) return false;
    ctx.auth.markSession(true);
    return true;
  }
  const stored = await ctx.auth.readStored();
  if (!stored?.refreshToken || stored.refreshToken === startedWith) return false;
  ctx.auth.apply(stored, false);
  return true;
}

async function requestTokens(ctx: RefreshContext, generation: number): Promise<Outcome> {
  const body = ctx.buildRefreshBody(ctx.auth.refreshToken);
  const headers: Record<string, string> = { ...ctx.defaultHeaders };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const csrf = await ctx.readCsrf();
  if (csrf) headers[ctx.csrfHeaderName] = csrf;

  // A refresh endpoint that never answers must not hang every request waiting on it.
  const controller = new AbortController();
  const timer = ctx.timeout > 0 ? setTimeout(() => controller.abort(), ctx.timeout) : undefined;
  let response: Response;
  let payload: unknown;
  try {
    response = await fetch(ctx.url, {
      method: "POST",
      headers,
      credentials: ctx.credentials,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    payload = response.ok ? await response.json().catch(() => undefined) : undefined;
  } catch {
    // Offline, DNS, timeout: says nothing about the session, so it survives.
    return "failed";
  } finally {
    if (timer) clearTimeout(timer);
  }

  // The session was ended or replaced meanwhile; this answer belongs to the old one.
  if (ctx.auth.generation !== generation) return "failed";
  // Only 401/403 is the server's verdict that the session is dead; 5xx/429 are not.
  if (response.status === 401 || response.status === 403) return "rejected";
  if (!response.ok) return "failed";

  const tokens = ctx.extractTokens(payload);
  if (tokens?.accessToken || tokens?.refreshToken) {
    ctx.auth.apply(tokens);
  } else if (ctx.authMode === "cookie") {
    // The server rotated httpOnly cookies and returned no body.
    ctx.auth.markSession(true);
  } else {
    return "rejected";
  }
  return "ok";
}

/**
 * The refresh flow, serialized across tabs. `true` when the session is usable
 * again. Coalescing within one tab is the caller's job (`AuthStore`).
 */
export function runRefresh(ctx: RefreshContext): Promise<boolean> {
  const generation = ctx.auth.generation;
  const startedWith = ctx.auth.refreshToken;
  const queuedAt = Date.now();

  const turn = ctx.tabs.exclusive(async () => {
    if (ctx.auth.generation !== generation) return false;
    if (await adoptSiblingRefresh(ctx, startedWith, queuedAt)) return true;

    if (ctx.authMode === "header" && !ctx.auth.refreshToken) {
      ctx.reject();
      return false;
    }

    const outcome = await requestTokens(ctx, generation);
    if (outcome === "rejected") ctx.reject();
    if (outcome !== "ok") return false;

    // Durable before the lock is released, so the next tab in line adopts it.
    await ctx.auth.flush();
    ctx.tabs.post({ type: "refreshed", tabId: ctx.tabs.tabId, expiresAt: ctx.auth.expiresAt });
    return true;
    // The tab ahead may spend a full `timeout` on its own refresh; don't give up just before it lands.
  }, ctx.timeout * 2);

  // Never got the lock in time: a failed refresh, which keeps the session.
  return turn.catch((error: unknown) => {
    if ((error as { name?: string } | undefined)?.name === "AbortError") return false;
    throw error;
  });
}
