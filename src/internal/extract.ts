import type { RefreshBodyConfig, TokenFieldMap, TokenPair, TokenExtractor } from "../types";

/** Default key names for the access token, in priority order. */
export const DEFAULT_ACCESS_KEYS = [
  "access",
  "accessToken",
  "access_token",
  "token",
  "jwt",
  "idToken",
  "id_token",
] as const;

/** Default key names for the refresh token, in priority order. */
export const DEFAULT_REFRESH_KEYS = ["refresh", "refreshToken", "refresh_token"] as const;

/** Default key names for an absolute expiry (epoch seconds or milliseconds). */
const DEFAULT_EXPIRY_KEYS = ["expiresAt", "expires_at", "expiry"] as const;

/** Default key names for an expiry given as a duration in seconds. */
const DEFAULT_EXPIRES_IN_KEYS = ["expiresIn", "expires_in"] as const;

/** Default top-level keys whose object value is searched for tokens. */
const DEFAULT_ROOTS = ["data", "tokens", "result", "payload"] as const;

function pick(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function pickExpiry(
  source: Record<string, unknown>,
  absoluteKeys: readonly string[],
  durationKeys: readonly string[],
): number | undefined {
  for (const key of absoluteKeys) {
    const value = source[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    // Seconds vs milliseconds: anything below ~year 2001 in ms is really seconds.
    return value < 1e12 ? value * 1000 : value;
  }
  for (const key of durationKeys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return Date.now() + value * 1000;
  }
  return undefined;
}

/**
 * Forgiving default token extractor.
 *
 * Understands the common REST/JWT response shapes — `{ access, refresh }`,
 * `{ access_token, refresh_token }`, `{ accessToken, refreshToken }` — at the
 * top level, or nested under `data`, `tokens`, `result`, or `payload`.
 */
export const defaultExtractTokens: TokenExtractor = (body): TokenPair | null => {
  if (!body || typeof body !== "object") return null;

  const roots: Record<string, unknown>[] = [];
  const top = body as Record<string, unknown>;
  roots.push(top);

  for (const nest of DEFAULT_ROOTS) {
    const value = top[nest];
    if (value && typeof value === "object") roots.push(value as Record<string, unknown>);
  }

  for (const root of roots) {
    const accessToken = pick(root, DEFAULT_ACCESS_KEYS);
    const refreshToken = pick(root, DEFAULT_REFRESH_KEYS);
    if (accessToken || refreshToken) {
      return {
        accessToken,
        refreshToken,
        expiresAt: pickExpiry(root, DEFAULT_EXPIRY_KEYS, DEFAULT_EXPIRES_IN_KEYS),
      };
    }
  }

  return null;
};

/**
 * Builds a token extractor from a declarative {@link TokenFieldMap}.
 *
 * The map is plain data, so unlike a custom `extractTokens` function it can be
 * structured-cloned into the request worker — custom key names and nesting no
 * longer force the client out of worker isolation.
 */
export function extractorFromMapping(mapping: TokenFieldMap): TokenExtractor {
  const access = mapping.accessKeys?.length ? mapping.accessKeys : DEFAULT_ACCESS_KEYS;
  const refresh = mapping.refreshKeys?.length ? mapping.refreshKeys : DEFAULT_REFRESH_KEYS;
  const expiry = mapping.expiryKeys?.length ? mapping.expiryKeys : DEFAULT_EXPIRY_KEYS;
  const expiresIn = mapping.expiresInKeys?.length ? mapping.expiresInKeys : DEFAULT_EXPIRES_IN_KEYS;
  const roots = mapping.roots?.length ? mapping.roots : DEFAULT_ROOTS;

  return (body): TokenPair | null => {
    if (!body || typeof body !== "object") return null;

    const top = body as Record<string, unknown>;
    const candidates: Record<string, unknown>[] = [top];
    for (const nest of roots) {
      const value = top[nest];
      if (value && typeof value === "object") candidates.push(value as Record<string, unknown>);
    }

    for (const root of candidates) {
      const accessToken = pick(root, access);
      const refreshToken = pick(root, refresh);
      if (accessToken || refreshToken) {
        return {
          accessToken,
          refreshToken,
          expiresAt: pickExpiry(root, expiry, expiresIn),
        };
      }
    }

    return null;
  };
}

/** Normalizes the `extractTokens` option (function, map, or nothing). */
export function normalizeExtractor(input?: TokenExtractor | TokenFieldMap): TokenExtractor {
  if (typeof input === "function") return input;
  if (input) return extractorFromMapping(input);
  return defaultExtractTokens;
}

/**
 * Builds a refresh-request body from a declarative {@link RefreshBodyConfig}.
 * Plain data, so it survives the trip into the request worker.
 */
export function refreshBodyFromConfig(config: RefreshBodyConfig): (refresh?: string) => unknown {
  const field = config.field ?? "refresh";
  return (refresh) => (refresh ? { [field]: refresh } : {});
}

/** Normalizes the `buildRefreshBody` option (function, config, or nothing). */
export function normalizeRefreshBody(
  input?: ((refreshToken?: string) => unknown) | RefreshBodyConfig,
): (refresh?: string) => unknown {
  if (typeof input === "function") return input;
  if (input) return refreshBodyFromConfig(input);
  return (refresh) => (refresh ? { refresh } : {});
}

/**
 * The field names that count as tokens, given an optional custom map.
 *
 * The default names are always included: even when a custom map renames the
 * tokens, a response may still carry the standard keys somewhere.
 */
export function tokenFieldNames(mapping?: TokenFieldMap): Set<string> {
  const access = mapping?.accessKeys?.length ? mapping.accessKeys : DEFAULT_ACCESS_KEYS;
  const refresh = mapping?.refreshKeys?.length ? mapping.refreshKeys : DEFAULT_REFRESH_KEYS;
  return new Set<string>([...DEFAULT_ACCESS_KEYS, ...DEFAULT_REFRESH_KEYS, ...access, ...refresh]);
}

/**
 * Removes token-bearing fields from a response body, in place, wherever they
 * appear (bounded depth, cycle-safe).
 *
 * Used at the worker → host boundary: a login response usually carries the
 * tokens themselves, and worker mode promises they never reach the main
 * thread. The extractor reads these names at the top level and under
 * `data`/`tokens`/`result`/`payload`; we remove them at any depth so no
 * wrapping shape can smuggle them across. Pass the active `TokenFieldMap` so
 * custom key names are stripped too.
 */
export function stripTokenFields(body: unknown, mapping?: TokenFieldMap): unknown {
  if (!body || typeof body !== "object") return body;

  const fields = tokenFieldNames(mapping);
  const seen = new Set<object>();

  const walk = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value !== "object") return value;
    // Cycles are impossible in parsed JSON, but a custom body is not.
    if (depth > 10 || seen.has(value)) return value;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = walk(value[i], depth + 1);
      return value;
    }

    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (fields.has(key)) delete record[key];
      else record[key] = walk(record[key], depth + 1);
    }
    return value;
  };

  return walk(body, 0);
}

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
