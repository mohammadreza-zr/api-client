/**
 * Request cancellation.
 *
 * Three pieces live here:
 *
 *   1. `CancelError`   — a deliberate cancellation, disguised as an `AbortError`
 *                        so `fetch` and the platform treat it correctly.
 *   2. Pattern matching — turns `"/api/v1/products"` or `"/users/:id/posts"`
 *                        into a predicate over in-flight requests.
 *   3. `CancelRegistry` — the set of cancelable in-flight requests, and the
 *                        controller that can stop each one.
 *
 * The registry always lives on the thread that owns the public client, so
 * `api.cancel()` works identically in worker and main-thread mode.
 */

import type {
  CancelMatch,
  CancelOptions,
  CancelSelector,
  HttpMethod,
  PendingRequest,
  RequestConfig,
} from "../types";
import { buildUrl } from "./url";

// ── errors ───────────────────────────────────────────────

/**
 * A cancellation the application asked for.
 *
 * `name` is `"AbortError"` on purpose: that is what `fetch` and every
 * `AbortSignal` consumer key off, so a canceled request fails exactly like an
 * aborted one. The extra `isCancelError` marker is what lets the engine tell
 * the two apart and attach the reason — `instanceof` is unreliable once the
 * worker bundle is a separate realm.
 */
export class CancelError extends Error {
  readonly isCancelError = true;
  readonly reason?: string;

  constructor(reason?: string) {
    super(reason ? `Request canceled: ${reason}` : "Request aborted");
    this.name = "AbortError";
    this.reason = reason;
  }
}

/** The message an aborted/canceled request should carry. */
export function cancelMessage(error: unknown): string {
  const candidate = error as { isCancelError?: boolean; message?: string } | undefined;
  if (candidate?.isCancelError && candidate.message) return candidate.message;
  return "Request aborted";
}

/** Extracts the human-readable reason from an abort reason, when there is one. */
export function reasonOf(value: unknown): string | undefined {
  const candidate = value as { isCancelError?: boolean; reason?: string } | undefined;
  return candidate?.isCancelError ? candidate.reason : undefined;
}

// ── URL patterns ─────────────────────────────────────────

/** Strips the origin, the hash and the query, leaving a comparable path. */
export function toPath(url: string): string {
  let path = url;

  const scheme = path.indexOf("://");
  if (scheme !== -1) {
    const slash = path.indexOf("/", scheme + 3);
    path = slash === -1 ? "/" : path.slice(slash);
  }

  const hash = path.indexOf("#");
  if (hash !== -1) path = path.slice(0, hash);

  const query = path.indexOf("?");
  if (query !== -1) path = path.slice(0, query);

  return path || "/";
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function matchFrom(
  pattern: string[],
  target: string[],
  pi: number,
  ti: number,
  prefix: boolean,
): boolean {
  if (pi === pattern.length) return prefix || ti === target.length;

  const token = pattern[pi];

  // `**` — zero or more segments.
  if (token === "**") {
    for (let k = ti; k <= target.length; k++) {
      if (matchFrom(pattern, target, pi + 1, k, prefix)) return true;
    }
    return false;
  }

  if (ti >= target.length) return false;

  // `*` and `:param` — exactly one segment, any value.
  if (token === "*" || token.startsWith(":")) {
    return matchFrom(pattern, target, pi + 1, ti + 1, prefix);
  }

  if (token !== target[ti]) return false;
  return matchFrom(pattern, target, pi + 1, ti + 1, prefix);
}

/**
 * Matches a URL pattern against a request path.
 *
 * Matching is **segment-aware and prefix-based**, which is what makes the
 * common case a one-liner: `"/api/v1/products"` cancels `/api/v1/products`,
 * `/api/v1/products/12` and `/api/v1/products/12/reviews`, but never
 * `/api/v1/products-archive`.
 *
 * - `*`      one segment       — `/users/*\/posts`
 * - `**`     zero or more      — `/api/**\/images`
 * - `:name`  one segment       — `/users/:id`
 * - `$`      suffix, exact     — `/users$` matches `/users` and nothing below it
 *
 * Query strings are ignored; use a predicate selector to inspect them.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  let raw = pattern.trim();
  if (!raw) return false;

  // A trailing `$` opts out of prefix matching.
  const exact = raw.endsWith("$");
  if (exact) raw = raw.slice(0, -1);

  const patternPath = toPath(raw);
  const patternSegments = segmentsOf(patternPath);

  // `"/"` (or `"/$"`) means "everything".
  if (patternSegments.length === 0) return !exact || segmentsOf(path).length === 0;

  return matchFrom(patternSegments, segmentsOf(path), 0, 0, !exact);
}

// ── selectors ────────────────────────────────────────────

function matchesObject(request: PendingRequest, match: CancelMatch): boolean {
  if (match.key !== undefined && request.key !== match.key) return false;
  if (match.group !== undefined && !request.groups.includes(match.group)) return false;

  if (match.method !== undefined) {
    const methods = Array.isArray(match.method) ? match.method : [match.method];
    if (!methods.includes(request.method)) return false;
  }

  if (match.url !== undefined) {
    const matched =
      match.url instanceof RegExp
        ? match.url.test(request.url) || match.url.test(request.path)
        : matchesPattern(match.url, request.path);
    if (!matched) return false;
  }

  return true;
}

/**
 * Decides whether one in-flight request is targeted by a selector.
 *
 * A bare string is deliberately forgiving — it matches a `cancelKey`, a
 * `cancelGroup`, **or** a URL pattern — because at the call site you know
 * which one you meant. Use a {@link CancelMatch} object when you need to be
 * unambiguous.
 */
export function matchesSelector(request: PendingRequest, selector: CancelSelector): boolean {
  if (typeof selector === "function") {
    try {
      return selector(request) === true;
    } catch {
      // A throwing predicate must not take the whole sweep down.
      return false;
    }
  }

  if (selector instanceof RegExp) {
    return selector.test(request.url) || selector.test(request.path);
  }

  if (typeof selector === "string") {
    if (request.key === selector) return true;
    if (request.groups.includes(selector)) return true;
    return matchesPattern(selector, request.path);
  }

  if (selector && typeof selector === "object") return matchesObject(request, selector);

  return false;
}

// ── configuration ────────────────────────────────────────

/** Client-wide cancellation settings, normalized. */
export interface CancelDefaults {
  /** Whether requests are tracked automatically. */
  enabled: boolean;
  /** Methods covered when `enabled`. */
  methods: "all" | ReadonlySet<HttpMethod>;
  /**
   * Whether a canceled request rejects. Independent of `throwError`, because
   * a cancellation is not an error — see {@link resolveCancelDefaults}.
   */
  throwOnCancel: boolean;
  /** Whether every cancelable request supersedes its previous twin. */
  takeLatest: boolean;
}

/**
 * GET only by default.
 *
 * Cancelling a read is always safe. Cancelling a write is not — the server may
 * already have committed it, and the client would never learn the outcome. So
 * writes are opt-in, per request or via `methods`.
 */
const GET_ONLY: ReadonlySet<HttpMethod> = new Set<HttpMethod>(["GET"]);

/**
 * Cancellation resolves by default, even when `throwError` is on.
 *
 * A cancellation is something the application asked for, not a failure, and
 * treating it as one costs more than it gives:
 *
 * 1. **TanStack Query retries it.** A rejection looks like a retryable error,
 *    so Query re-fires the very request that was just canceled. Measured: two
 *    server hits with throwing, one without. Query's own `signal` path is
 *    unaffected either way — it short-circuits before the promise settles —
 *    so throwing buys nothing there and actively harms `api.cancel()`.
 *
 * 2. **It produces unhandled rejections in the common React pattern.** An
 *    async IIFE inside `useEffect` has no `catch`, so cancelling on unmount
 *    surfaces a red overlay in dev and error-reporter noise in production.
 *
 * `onError` already skips cancellations; rejecting while suppressing the
 * error hook would be half a position. Real failures still throw per
 * `throwError` — only cancellation is exempt. Opt back in with
 * `throwOnCancel: true`.
 */
export function resolveCancelDefaults(option: boolean | CancelOptions | undefined): CancelDefaults {
  if (option === undefined || option === false) {
    return { enabled: false, methods: GET_ONLY, throwOnCancel: false, takeLatest: false };
  }

  if (option === true) {
    return { enabled: true, methods: GET_ONLY, throwOnCancel: false, takeLatest: false };
  }

  return {
    enabled: true,
    methods:
      option.methods === "all"
        ? "all"
        : option.methods && option.methods.length > 0
          ? new Set(option.methods)
          : GET_ONLY,
    throwOnCancel: option.throwOnCancel === true,
    takeLatest: option.takeLatest === true,
  };
}

/** Whether the client-wide setting covers this method. */
export function coversMethod(defaults: CancelDefaults, method: HttpMethod): boolean {
  return defaults.methods === "all" || defaults.methods.has(method);
}

/**
 * Whether one request should be tracked and made cancelable.
 *
 * Precedence: an explicit `cancelable` wins; asking for a `cancelKey` or
 * `takeLatest` implies you intend to cancel it; otherwise the client-wide
 * setting decides. A `cancelGroup` alone only tags the request — it does not
 * make a write cancelable behind your back.
 */
export function isCancelable(
  method: HttpMethod,
  config: RequestConfig<unknown> | undefined,
  defaults: CancelDefaults,
): boolean {
  if (config?.cancelable !== undefined) return config.cancelable;
  if (config?.cancelKey !== undefined || config?.takeLatest === true) return true;
  if (!defaults.enabled) return false;
  return coversMethod(defaults, method);
}

/** Normalizes `cancelGroup` into a list. */
export function groupsOf(config: RequestConfig<unknown> | undefined): string[] {
  const group = config?.cancelGroup;
  if (!group) return [];
  return (Array.isArray(group) ? group : [group]).filter((g): g is string => Boolean(g));
}

// ── signal linking ───────────────────────────────────────

/**
 * Combines signals into one, preserving whichever `reason` fires first.
 *
 * `AbortSignal.any` is used where available. The fallback attaches listeners,
 * so it returns a `release` that detaches them: a long-lived scope controller
 * would otherwise accumulate one listener per request it ever covered.
 */
export function linkSignals(
  signals: (AbortSignal | null | undefined)[],
): { signal: AbortSignal; release: () => void } {
  const active = signals.filter((s): s is AbortSignal => Boolean(s));

  if (active.length === 0) return { signal: new AbortController().signal, release: () => {} };
  if (active.length === 1) return { signal: active[0], release: () => {} };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyFn = (AbortSignal as any)?.any;
  if (typeof anyFn === "function") {
    return { signal: anyFn.call(AbortSignal, active) as AbortSignal, release: () => {} };
  }

  const controller = new AbortController();
  const already = active.find((s) => s.aborted);
  if (already) {
    controller.abort(already.reason);
    return { signal: controller.signal, release: () => {} };
  }

  const detach: (() => void)[] = [];
  for (const source of active) {
    const onAbort = () => controller.abort(source.reason);
    source.addEventListener("abort", onAbort, { once: true });
    detach.push(() => source.removeEventListener("abort", onAbort));
  }

  return {
    signal: controller.signal,
    release: () => {
      for (const off of detach) off();
      detach.length = 0;
    },
  };
}

// ── registry ─────────────────────────────────────────────

interface Entry extends PendingRequest {
  controller: AbortController;
  /** Identity used by `takeLatest`; falls back to `METHOD path`. */
  latestKey: string;
}

/** What the caller needs back to run and then release a tracked request. */
export interface Tracked {
  id: number;
  signal: AbortSignal;
  release: () => void;
}

export interface TrackInput {
  method: HttpMethod;
  /** Fully resolved URL, query included. */
  url: string;
  key?: string;
  groups: string[];
  takeLatest: boolean;
}

/** The set of cancelable in-flight requests. */
export class CancelRegistry {
  private seq = 0;
  private entries = new Map<number, Entry>();

  /** Registers a request and hands back the signal that can stop it. */
  track(input: TrackInput): Tracked {
    const path = toPath(input.url);
    const latestKey = input.key ?? `${input.method} ${path}`;

    // Take-latest: the newest caller wins, so retire the previous twin first.
    if (input.takeLatest) {
      for (const entry of [...this.entries.values()]) {
        if (entry.latestKey === latestKey) {
          this.abort(entry, new CancelError("superseded by a newer request"));
        }
      }
    }

    const id = ++this.seq;
    const entry: Entry = {
      id,
      method: input.method,
      url: input.url,
      path,
      key: input.key,
      groups: input.groups,
      startedAt: Date.now(),
      controller: new AbortController(),
      latestKey,
    };

    this.entries.set(id, entry);

    return {
      id,
      signal: entry.controller.signal,
      release: () => {
        this.entries.delete(id);
      },
    };
  }

  private abort(entry: Entry, error: CancelError): void {
    this.entries.delete(entry.id);
    try {
      entry.controller.abort(error);
    } catch {
      /* a controller can only be aborted once */
    }
  }

  /**
   * Cancels every tracked request matching `selector`, or all of them when it
   * is omitted. Returns how many were stopped.
   */
  cancel(selector?: CancelSelector, reason?: string): number {
    const error = new CancelError(reason);
    let count = 0;

    for (const entry of [...this.entries.values()]) {
      if (selector !== undefined && !matchesSelector(entry, selector)) continue;
      this.abort(entry, error);
      count++;
    }

    return count;
  }

  /** Snapshot of the tracked in-flight requests, newest last. */
  pending(selector?: CancelSelector): PendingRequest[] {
    const out: PendingRequest[] = [];

    for (const entry of this.entries.values()) {
      if (selector !== undefined && !matchesSelector(entry, selector)) continue;
      out.push({
        id: entry.id,
        method: entry.method,
        url: entry.url,
        path: entry.path,
        key: entry.key,
        groups: entry.groups,
        startedAt: entry.startedAt,
      });
    }

    return out;
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Resolves the URL a request will be sent to, for matching purposes.
 *
 * Registration happens before the engine builds its own URL, so this mirrors
 * that step — and swallows the errors the engine reports properly (a falsy
 * `addToUrl` segment), falling back to the raw path so tracking never changes
 * which error the caller sees.
 */
export function previewUrl(
  url: string,
  baseUrl: string,
  config: RequestConfig<unknown> | undefined,
): string {
  try {
    return buildUrl({
      url,
      baseUrl: config?.baseUrl ?? baseUrl,
      addToUrl: config?.addToUrl,
      addTemplateToUrl: config?.addTemplateToUrl,
      params: config?.params as Record<string, unknown> | undefined,
    });
  } catch {
    return url;
  }
}
