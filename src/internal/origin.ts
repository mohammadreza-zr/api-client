const ABSOLUTE_URL = /^[a-z][a-z\d+\-.]*:/i;

function originOf(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin && origin !== "null" ? origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The origins allowed to receive the access token and CSRF header: the
 * client's `baseUrl` origin plus any explicit `authOrigins`.
 */
export function trustedOrigins(baseUrl: string, extra: readonly string[] = []): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const url of [baseUrl, ...extra]) {
    const origin = originOf(url);
    if (origin) origins.add(origin);
  }
  return origins;
}

/**
 * Whether credentials may be attached to a request for `url`.
 *
 * A path without a scheme or host resolves against the page's own origin, so
 * it is trusted. Anything with a host — absolute or protocol-relative — must
 * match a trusted origin, otherwise a caller-supplied URL (or one injected by
 * XSS) would receive the bearer token.
 */
export function isTrustedUrl(url: string, trusted: ReadonlySet<string>): boolean {
  if (url.startsWith("//")) {
    const page = typeof location !== "undefined" ? location.href : undefined;
    const origin = page ? originOf(new URL(url, page).href) : undefined;
    return origin !== undefined && trusted.has(origin);
  }
  if (!ABSOLUTE_URL.test(url)) return true;
  const origin = originOf(url);
  return origin !== undefined && trusted.has(origin);
}
