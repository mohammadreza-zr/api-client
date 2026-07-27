/** Minimal, dependency-free JWT expiry reading. Never used for verification. */

/** base64url → utf-8, working in browsers, workers and Node. */
function decodeBase64Url(input: string): string | null {
  try {
    let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
    const pad = base64.length % 4;
    if (pad === 2) base64 += "==";
    else if (pad === 3) base64 += "=";
    else if (pad === 1) return null;

    if (typeof atob === "function") {
      const binary = atob(base64);
      // Reconstruct UTF-8 so non-ASCII claims survive.
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      if (typeof TextDecoder !== "undefined") {
        return new TextDecoder().decode(bytes);
      }
      return binary;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const B: any = (globalThis as any).Buffer;
    if (B) return B.from(base64, "base64").toString("utf-8");

    return null;
  } catch {
    return null;
  }
}

/**
 * Reads the `exp` claim as epoch milliseconds.
 * Returns `null` for opaque (non-JWT) tokens so callers can tell
 * "no expiry information" apart from "expires soon".
 */
export function getTokenExpiry(token?: string | null): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const json = decodeBase64Url(parts[1]);
  if (!json) return null;

  try {
    const payload = JSON.parse(json) as { exp?: number };
    if (typeof payload.exp !== "number") return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/** True when the token has a known expiry that has already passed (with skew). */
export function isTokenExpired(token: string | null | undefined, skewMs = 0): boolean {
  const exp = getTokenExpiry(token);
  if (exp === null) return false; // unknown expiry → let the server decide
  return Date.now() + skewMs >= exp;
}
