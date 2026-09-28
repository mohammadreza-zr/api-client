import type { ClientOptions } from "../types";

export type CsrfReader = () => Promise<string | undefined>;

/** A provider that never settles must not stall every write and refresh behind it. */
const PROVIDER_TIMEOUT_MS = 5_000;

function withinProviderTimeout<T>(pending: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), PROVIDER_TIMEOUT_MS);
  });
  return Promise.race([pending, expired]).finally(() => clearTimeout(timer));
}

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
        return (await withinProviderTimeout(Promise.resolve(getCsrfToken()))) || undefined;
      } catch {
        return undefined;
      }
    }
    return xsrfCookieName ? readCookie(xsrfCookieName) : undefined;
  };
}
