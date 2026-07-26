/** Detects whether we are running on the server. */
export function isServer(): boolean {
  return typeof window === "undefined";
}

/**
 * Reads the base URL from the environment.
 * Supports Next.js (NEXT_PUBLIC_BASE_URL) and Vite (VITE_BASE_URL).
 */
export function getEnvBaseUrl(): string {
  // Next.js / Node
  if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_BASE_URL) {
    return process.env.NEXT_PUBLIC_BASE_URL;
  }

  // Vite (browser)
  try {
    const meta = (import.meta as any)?.env;
    if (meta?.VITE_BASE_URL) return meta.VITE_BASE_URL;
  } catch {
    // import.meta unavailable in CJS
  }

  return "";
}

/** Mutates obj by deleting keys whose value is undefined, null, or "". */
export function removeEmptyValues(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined || obj[key] === null || obj[key] === "") {
      delete obj[key];
    }
  }
}

/** Small structured-clone for plain objects. */
export function shallowClone<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return [...obj] as unknown as T;
  return { ...obj };
}
