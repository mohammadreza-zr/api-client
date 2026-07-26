/** Runtime capability detection. No bundler-specific globals leak out of here. */

export const isServer = (): boolean => typeof window === "undefined";

export const hasWorker = (): boolean =>
  typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL?.createObjectURL === "function";

export const hasBroadcastChannel = (): boolean => typeof BroadcastChannel !== "undefined";

/** Reads a process env var without assuming `process` exists. */
function fromProcess(key: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = (globalThis as any)?.process?.env;
    const value = env?.[key];
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads an env var from Vite's `import.meta.env` when available.
 * Written so bundlers that statically replace `import.meta.env` still work,
 * and CJS builds (where `import.meta` is a syntax error) never see it.
 */
function fromImportMeta(key: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (globalThis as any)?.__VITE_ENV__ ?? undefined;
    const value = meta?.[key];
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}

const BASE_URL_KEYS = [
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_BASE_URL",
  "VITE_API_URL",
  "VITE_BASE_URL",
  "NUXT_PUBLIC_API_URL",
  "PUBLIC_API_URL",
  "API_URL",
];

/** Best-effort base URL discovery across Next, Vite, Nuxt, SvelteKit and Node. */
export function detectBaseUrl(): string {
  for (const key of BASE_URL_KEYS) {
    const value = fromProcess(key) ?? fromImportMeta(key);
    if (value) return value;
  }
  return "";
}
