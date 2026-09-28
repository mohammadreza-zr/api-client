import { pageOrigin } from "./env";

function originOf(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin && origin !== "null" ? origin : undefined;
  } catch {
    return undefined;
  }
}

/** The page the client runs in; a Blob worker's `blob:` prefix is dropped so URLs resolve against the app. */
function pageHref(): string | undefined {
  try {
    return typeof location !== "undefined" && location.href ? location.href.replace(/^blob:/, "") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves a request URL the way `fetch` would, against the page.
 *
 * The engine checks trust on this exact string and fetches this exact string,
 * so the two can never disagree: the URL parser treats `\\evil.com`,
 * `/\evil.com` and `//evil.com` as naming a host, and so does the check.
 * Without a page (Node, SSR) a URL is returned as given.
 */
export function resolveRequestUrl(url: string): string {
  const page = pageHref();
  if (!page) return url;
  try {
    return new URL(url, page).href;
  } catch {
    return url;
  }
}

/**
 * The origins allowed to receive the access token and CSRF header: the
 * client's `baseUrl` origin, any explicit `authOrigins`, and the page's own
 * origin (where same-origin, relative requests go).
 */
export function trustedOrigins(baseUrl: string, extra: readonly string[] = []): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const url of [baseUrl, pageOrigin(), ...extra]) {
    const origin = originOf(url);
    if (origin) origins.add(origin);
  }
  return origins;
}

/** Whether credentials may go to `url`, a URL already passed through `resolveRequestUrl`. */
export function isTrustedUrl(url: string, trusted: ReadonlySet<string>): boolean {
  const origin = originOf(url);
  return origin !== undefined && trusted.has(origin);
}
