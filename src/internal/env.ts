/** Runtime capability detection. No bundler-specific globals leak out of here. */

export const isServer = (): boolean => typeof window === "undefined";

export const hasWorker = (): boolean =>
  typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL?.createObjectURL === "function";

export const hasBroadcastChannel = (): boolean => typeof BroadcastChannel !== "undefined";

/* eslint-disable @typescript-eslint/no-explicit-any */

type EnvBag = Record<string, string | undefined>;

/** Keeps only non-empty strings, so `""` never wins over a later source. */
function clean(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Static, literal env reads.
 *
 * This is the part that actually makes auto-detection work in the browser.
 * Next.js, Vite, Nuxt, SvelteKit and friends inline env vars by *textually*
 * replacing `process.env.NEXT_PUBLIC_FOO` / `import.meta.env.VITE_FOO` at
 * build time — including inside `node_modules`. A dynamic lookup such as
 * `process.env[key]` is invisible to that pass, and in a browser bundle
 * `process` usually does not exist at all, so the previous dynamic-only
 * implementation always resolved to `""` on the client.
 *
 * Every read is individually guarded: an unreplaced `process` or
 * `import.meta.env` throws a (catchable) ReferenceError instead of an
 * inlined value.
 */
function staticEnv(): EnvBag {
  const bag: EnvBag = {};
  const put = (key: string, read: () => unknown): void => {
    try {
      const value = clean(read());
      if (value !== undefined && bag[key] === undefined) bag[key] = value;
    } catch {
      /* not defined in this runtime */
    }
  };

  // Next.js (and anything webpack/turbopack-based).
  put("NEXT_PUBLIC_API_URL", () => process.env.NEXT_PUBLIC_API_URL);
  put("NEXT_PUBLIC_BASE_URL", () => process.env.NEXT_PUBLIC_BASE_URL);
  put("NUXT_PUBLIC_API_URL", () => process.env.NUXT_PUBLIC_API_URL);
  put("PUBLIC_API_URL", () => process.env.PUBLIC_API_URL);
  put("API_URL", () => process.env.API_URL);
  put("VITE_API_URL", () => process.env.VITE_API_URL);
  put("VITE_BASE_URL", () => process.env.VITE_BASE_URL);

  /*
   * Vite / SvelteKit / Astro / Nuxt 3 client bundles.
   *
   * Written as a plain, unbroken member chain on purpose: `define`-style
   * replacement matches the exact text `import.meta.env.VITE_API_URL`, and
   * inserting `?.` anywhere in the chain stops the substitution. A missing
   * `import.meta.env` just throws a TypeError, which `put` swallows.
   */
  put("VITE_API_URL", () => (import.meta as any).env.VITE_API_URL);
  put("VITE_BASE_URL", () => (import.meta as any).env.VITE_BASE_URL);
  put("PUBLIC_API_URL", () => (import.meta as any).env.PUBLIC_API_URL);
  put("NUXT_PUBLIC_API_URL", () => (import.meta as any).env.NUXT_PUBLIC_API_URL);
  put("NEXT_PUBLIC_API_URL", () => (import.meta as any).env.NEXT_PUBLIC_API_URL);
  put("NEXT_PUBLIC_BASE_URL", () => (import.meta as any).env.NEXT_PUBLIC_BASE_URL);
  put("API_URL", () => (import.meta as any).env.API_URL);

  return bag;
}

/** Env objects that exist as real values at runtime and can be indexed. */
function dynamicBags(): EnvBag[] {
  const bags: EnvBag[] = [];

  const push = (read: () => unknown): void => {
    try {
      const bag = read();
      if (bag && typeof bag === "object") bags.push(bag as EnvBag);
    } catch {
      /* ignore */
    }
  };

  // Node, Bun, Deno-with-compat, Next server, Nuxt server.
  push(() => (globalThis as any)?.process?.env);
  // Vite exposes a real object here at runtime too (dev + SSR).
  push(() => (import.meta as any)?.env);
  // Escape hatches: `globalThis.__VITE_ENV__ = import.meta.env` and friends.
  push(() => (globalThis as any)?.__VITE_ENV__);
  push(() => (globalThis as any)?.__ENV__);
  push(() => (globalThis as any)?.ENV);

  return bags;
}

/** Ordered list of env var names consulted by {@link detectBaseUrl}. */
export const BASE_URL_KEYS = [
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_BASE_URL",
  "VITE_API_URL",
  "VITE_BASE_URL",
  "NUXT_PUBLIC_API_URL",
  "PUBLIC_API_URL",
  "API_URL",
] as const;

/** Best-effort base URL discovery across Next, Vite, Nuxt, SvelteKit and Node. */
export function detectBaseUrl(): string {
  // An explicit runtime override always wins — the one thing that also works
  // inside a Blob worker, where no bundler replacement ever happened.
  const override = clean((globalThis as any)?.__API_BASE_URL__);
  if (override) return override;

  const bags = [staticEnv(), ...dynamicBags()];

  for (const key of BASE_URL_KEYS) {
    for (const bag of bags) {
      const value = clean(bag?.[key]);
      if (value) return value;
    }
  }

  return "";
}
