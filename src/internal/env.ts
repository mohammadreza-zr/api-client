/** Runtime capability detection. No bundler-specific globals leak out of here. */

import { hasScheme } from "./url";

/**
 * True inside a Web Worker (dedicated or shared).
 *
 * A worker has no `window`, so a bare `typeof window === "undefined"` check
 * mistakes it for the server. `importScripts` is the reliable dedicated-worker
 * marker; the constructor names cover the rest.
 */
export const isWorkerScope = (): boolean => {
  try {
    if (typeof importScripts === "function") return true;
    const scope = globalThis as { WorkerGlobalScope?: unknown; self?: unknown };
    return typeof scope.WorkerGlobalScope !== "undefined" && scope.self === globalThis;
  } catch {
    return false;
  }
};

/**
 * True only in a non-browser runtime (Node, Bun, SSR) — NOT in a worker.
 *
 * Workers legitimately have `BroadcastChannel` and must take part in cross-tab
 * sync; treating them as "server" silently disabled it in worker mode.
 */
export const isServer = (): boolean => typeof window === "undefined" && !isWorkerScope();

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

  // Next.js, Create React App, Expo (and anything webpack/turbopack/Metro-based).
  put("NEXT_PUBLIC_API_URL", () => process.env.NEXT_PUBLIC_API_URL);
  put("NEXT_PUBLIC_API_BASE_URL", () => process.env.NEXT_PUBLIC_API_BASE_URL);
  put("NEXT_PUBLIC_BASE_URL", () => process.env.NEXT_PUBLIC_BASE_URL);
  put("REACT_APP_API_URL", () => process.env.REACT_APP_API_URL);
  put("EXPO_PUBLIC_API_URL", () => process.env.EXPO_PUBLIC_API_URL);
  put("PUBLIC_API_BASE_URL", () => process.env.PUBLIC_API_BASE_URL);
  put("API_BASE_URL", () => process.env.API_BASE_URL);
  put("NUXT_PUBLIC_API_URL", () => process.env.NUXT_PUBLIC_API_URL);
  put("PUBLIC_API_URL", () => process.env.PUBLIC_API_URL);
  put("API_URL", () => process.env.API_URL);
  put("VITE_API_URL", () => process.env.VITE_API_URL);
  put("VITE_API_BASE_URL", () => process.env.VITE_API_BASE_URL);
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
  put("VITE_API_BASE_URL", () => (import.meta as any).env.VITE_API_BASE_URL);
  put("VITE_BASE_URL", () => (import.meta as any).env.VITE_BASE_URL);
  put("PUBLIC_API_URL", () => (import.meta as any).env.PUBLIC_API_URL);
  put("PUBLIC_API_BASE_URL", () => (import.meta as any).env.PUBLIC_API_BASE_URL);
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

/**
 * Ordered list of env var names consulted by {@link detectBaseUrl}.
 * Vite's own `BASE_URL` is deliberately absent: it is the app's public path, not an API.
 */
export const BASE_URL_KEYS = [
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_API_BASE_URL",
  "NEXT_PUBLIC_BASE_URL",
  "VITE_API_URL",
  "VITE_API_BASE_URL",
  "VITE_BASE_URL",
  "NUXT_PUBLIC_API_URL",
  "REACT_APP_API_URL",
  "EXPO_PUBLIC_API_URL",
  "PUBLIC_API_URL",
  "PUBLIC_API_BASE_URL",
  "API_URL",
  "API_BASE_URL",
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

/** The page's origin where there is a page (a window or a worker), else `""`. */
export function pageOrigin(): string {
  try {
    const origin = typeof location !== "undefined" ? location.origin : "";
    return origin && origin !== "null" ? origin : "";
  } catch {
    return "";
  }
}

/**
 * The base URL a client uses: the explicit option, else an env variable, else
 * the page origin. Relative values are resolved against the page, as `fetch`
 * would — and so a Blob worker, whose own base is `blob:`, gets a usable one.
 */
export function resolveBaseUrl(explicit?: string): string {
  // `""` means "the page's own origin": explicit, so env detection must not override it.
  const base = explicit === undefined ? detectBaseUrl() || pageOrigin() : explicit || pageOrigin();
  try {
    if (base && typeof location !== "undefined") return new URL(base, location.href).href.replace(/\/+$/, "");
  } catch {
    /* not resolvable against this page: keep it as given */
  }
  return base.replace(/\/+$/, "");
}

const FETCHABLE_SCHEME = /^(https?|blob|data):/i;

/**
 * Fails fast, and helpfully, on a URL that cannot be fetched: a relative path
 * where there is no page to resolve it against (Node, SSR, tests), or a
 * `baseUrl` written without its scheme (`"localhost:4000"` parses as the
 * scheme `localhost:`, and fetch only says "fetch failed").
 */
export function assertFetchable(url: string): void {
  if (hasScheme(url) && !FETCHABLE_SCHEME.test(url)) {
    throw new Error(`"${url}" is not an http(s) URL. Does baseUrl need "http://" or "https://" in front?`);
  }
  if (hasScheme(url) || typeof location !== "undefined") return;
  throw new Error(
    `No base URL for "${url}". Pass createClient({ baseUrl: "https://api.example.com" }) ` +
      `or set one of ${BASE_URL_KEYS.join(", ")}.`,
  );
}
