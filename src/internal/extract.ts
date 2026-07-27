import type { TokenPair, TokenExtractor } from "../types";

const ACCESS_KEYS = ["access", "accessToken", "access_token", "token", "jwt", "idToken", "id_token"];
const REFRESH_KEYS = ["refresh", "refreshToken", "refresh_token"];
const EXPIRY_KEYS = ["expiresAt", "expires_at", "expiresIn", "expires_in", "expiry"];

function pick(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function pickExpiry(source: Record<string, unknown>): number | undefined {
  for (const key of EXPIRY_KEYS) {
    const value = source[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    // `expiresIn` is a duration; everything else is an absolute timestamp.
    if (key === "expiresIn" || key === "expires_in") return Date.now() + value * 1000;
    // Seconds vs milliseconds: anything below ~year 2001 in ms is really seconds.
    return value < 1e12 ? value * 1000 : value;
  }
  return undefined;
}

/**
 * Forgiving default token extractor.
 *
 * Understands the common REST/JWT response shapes — `{ access, refresh }`,
 * `{ access_token, refresh_token }`, `{ accessToken, refreshToken }` — at the
 * top level, or nested under `data`, `tokens`, or `result`.
 */
export const defaultExtractTokens: TokenExtractor = (body): TokenPair | null => {
  if (!body || typeof body !== "object") return null;

  const roots: Record<string, unknown>[] = [];
  const top = body as Record<string, unknown>;
  roots.push(top);

  for (const nest of ["data", "tokens", "result", "payload"]) {
    const value = top[nest];
    if (value && typeof value === "object") roots.push(value as Record<string, unknown>);
  }

  for (const root of roots) {
    const accessToken = pick(root, ACCESS_KEYS);
    const refreshToken = pick(root, REFRESH_KEYS);
    if (accessToken || refreshToken) {
      return { accessToken, refreshToken, expiresAt: pickExpiry(root) };
    }
  }

  return null;
};

/** Pulls `user` out of the same set of common response shapes. */
export function extractUser(body: unknown): unknown {
  if (!body || typeof body !== "object") return undefined;
  const top = body as Record<string, unknown>;
  if (top.user !== undefined) return top.user;
  for (const nest of ["data", "result", "payload"]) {
    const value = top[nest] as Record<string, unknown> | undefined;
    if (value && typeof value === "object" && value.user !== undefined) return value.user;
  }
  return undefined;
}
