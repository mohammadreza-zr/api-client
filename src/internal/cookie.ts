import type { ClientOptions } from "../types";

export type CsrfReader = () => Promise<string | undefined>;

/** Reads a single cookie value by name; `undefined` where there is no `document`. */
export function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Resolves the CSRF token: an explicit provider wins over the cookie, since
 * `document.cookie` does not exist inside a worker or on the server.
 * A failing provider means "no token", never a failed request.
 */
export function createCsrfReader(
  options: Pick<ClientOptions, "getCsrfToken" | "xsrfCookieName">,
): CsrfReader {
  const { getCsrfToken, xsrfCookieName } = options;
  return async () => {
    if (getCsrfToken) {
      try {
        return (await getCsrfToken()) || undefined;
      } catch {
        return undefined;
      }
    }
    return xsrfCookieName ? readCookie(xsrfCookieName) : undefined;
  };
}
