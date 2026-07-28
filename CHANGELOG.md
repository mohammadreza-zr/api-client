# Changelog

## Unreleased

## 1.1.0 - 2026-07-28

### Added

- **Request cancellation** — stop in-flight requests when the user changes
  page, closes a modal, or types the next keystroke. **Opt-in**: nothing is
  tracked, and there is no bookkeeping cost, until you set `cancel`.

  ```ts
  const api = createClient({ baseUrl, cancel: true });

  api.cancel();                     // everything in flight
  api.cancel("/api/v1/products");   // by URL pattern, cancelKey or cancelGroup
  ```

  - **URL patterns** are segment-aware prefixes, so `/api/v1/products` covers
    `/api/v1/products/12/reviews` but never `/api/v1/products-archive`.
    `*` and `:param` match one segment, `**` matches zero or more, and a
    trailing `$` makes the match exact. Selectors can also be a `RegExp`, an
    object (`{ url, method, key, group }`) or a predicate.

  - **`api.cancelScope(name)`** returns a wrapper whose requests are tagged
    together, so `scope.cancel()` stops everything a modal or page started.
    Scopes are self-enabling — they work on a client that never set `cancel`.

  - **`takeLatest`** retires the previous in-flight request with the same
    identity (`cancelKey`, or `METHOD + path`), which is the stale-search
    pattern built in.

  - **`api.pending(selector?)`** exposes what is currently tracked.

  Only `GET` is covered by default: cancelling a read is always safe, whereas
  a canceled write may already have been committed by the server and the
  client would never learn the outcome. Widen it with
  `cancel: { methods: "all" }`, or opt a single request in or out with
  `cancelable`.

  Cancellation is genuine in **worker mode** too — the registry lives on the
  main thread (so `cancel()` stays synchronous and works before the worker has
  booted) and forwards an `abort` message that stops the real `fetch`.

- **`canceled` and `cancelReason`** on `IRes` and `ApiError`, so a deliberate
  cancellation is distinguishable from a real failure without string-matching
  the message. A timeout keeps its own `408` and leaves `canceled` unset.

  ```ts
  catch (e) {
    if (e instanceof ApiError && e.canceled) return;   // expected
    throw e;
  }
  ```

- **`throwOnCancel`**, client-wide and per request, to make a cancellation
  reject when you want it to.

- New exported types: `CancelOptions`, `CancelSelector`, `CancelMatch`,
  `CancelScope`, `PendingRequest`.

### Changed

- **A canceled request now resolves instead of rejecting, even under
  `throwError: true`.** `throwOnCancel` is independent of `throwError` and
  defaults to `false`. Real failures still throw — only cancellation is
  exempt.

  This is a **behaviour change for existing `signal` users**: today an
  `AbortController.abort()` rejects under the default client, and now it
  resolves with `canceled: true`. Restore the old behaviour with
  `createClient({ cancel: { throwOnCancel: true } })`, or per request.

  Two measured reasons, both locked into `audit.mjs` against real
  `@tanstack/query-core`:

  1. **A rejected cancel triggers a retry storm.** react-query cannot tell a
     cancellation from an ordinary retryable failure, so it re-fires the
     request that was just canceled — two server hits instead of one. Its own
     `signal` path is unaffected either way, since it short-circuits before
     the promise settles, so throwing buys nothing there.

  2. **It breaks the ordinary React pattern.** An async IIFE inside
     `useEffect` has no `catch`, so cancelling on unmount surfaced an
     unhandled rejection — a red overlay in Next dev, noise in error
     reporters.

  Rejecting while `onError` stayed silent was also only half a position:
  either a cancellation is a failure or it is not.

- `onError` is **no longer fired for canceled requests**. A route change
  should not raise an error toast. Real failures are unaffected.

- `destroy()` now cancels tracked in-flight requests with the reason
  `"client destroyed"`, instead of leaving them to fail opaquely.

- `login()`, `logout()` and the `restoreSession()` probe are never tracked,
  even under `cancel: { methods: "all" }`. They establish the session, and a
  blanket `cancel()` on the first route change would otherwise abort the
  handshake and leave the app believing nobody is signed in.

### Internal

- Signal linking moved into `src/internal/cancel.ts` and generalized to any
  number of signals, so the timeout, the caller's `signal` and the registry's
  controller all compose. The fallback path (runtimes without
  `AbortSignal.any`) now detaches its listeners when a request settles — a
  long-lived scope controller would otherwise accumulate one per request it
  ever covered.

- Two new verification suites, **167 assertions**: `cancel.mjs` and
  `cancel-worker.mjs`, the latter driving the real inlined worker bundle
  through the real host protocol and asserting the server actually observes
  the aborted socket. Every row of the documented URL-pattern table is
  asserted, so the docs cannot drift from the matcher. 455 assertions total.

## 1.0.2

First release exercised against a real application. Every fix below is a bug
that made the library unusable in a normal browser setup — most of them
silent, and several masked by the fact that the test suites only ever ran on
the main thread in Node.

### Fixed

- **`baseUrl` auto-detection never worked in the browser.** Env vars were read
  through a dynamic `process.env[key]` index, which bundlers cannot inline and
  browser bundles have no `process` for, so detection always resolved to `""`
  and requests went to the page origin. Detection now uses literal, statically
  replaceable `process.env.FOO` / `import.meta.env.FOO` reads.

- **Worker mode never received the base URL.** The worker re-ran detection in
  a scope with no bundler-injected env, always got `""`, and sent every
  relative URL to the page origin. The host now resolves it and forwards it.

- **Persistent storage silently discarded everything in worker mode.**
  `localStorage`, `sessionStorage` and `document.cookie` are Window APIs that
  do not exist in a worker, so `"local"`, `"session"` and `"cookie"` all
  behaved like `"memory"` and users were logged out on every reload. Storage
  is now owned by the main thread, and the worker persists through it.
  `"memory"` still never leaves the worker.

- **Custom storage adapters silently disabled worker isolation**, because the
  object could not be structured-cloned. They now run on the main thread and
  keep worker mode.

- **`login()` / `setTokens()` could resolve before the write landed**, so a
  redirect immediately after login could lose the session. Writes are awaited
  at those points; ordinary requests are still never blocked on storage.

- **Cross-tab sync was dead in worker mode.** `isServer()` was
  `typeof window === "undefined"`, and a worker has no `window` either, so the
  BroadcastChannel was never opened and `multiTab` was a no-op by default.

- **`isAuthenticated` could never be `true` in `authMode: "cookie"`.** It
  required a readable access token, which httpOnly cookies never expose, so
  route guards and "signed in" UI never worked. Cookie mode now tracks the
  session from the server's responses.

- **Cookie mode only propagated logout across tabs, never login.** The handler
  re-read shared storage, which cookie mode does not have.

- **Relative URLs failed in worker mode.** A Blob worker's base is a `blob:`
  URL, which relative paths cannot resolve against. The host now falls back to
  the page origin, so `baseUrl: window.location.origin` is no longer needed
  (and that workaround broke SSR).

- **`npm pack` shipped a stale or empty `dist/`.** The build was attached to
  `prepublishOnly`, which only runs on `npm publish` — so tarballs contained no
  code, or code from an earlier commit. The build now runs from `prepare`,
  which also covers `npm link`, `npm pack` and folder/git installs.
  `npm ci --omit=dev` still succeeds: the hook skips when the build toolchain
  is absent.

### Added

- **`restoreSession(url?)`** — detects an existing httpOnly-cookie session on
  startup, which is otherwise impossible from JS after a page reload. Pass a
  probe endpoint to also populate `state.user`; omit it to try the refresh
  endpoint. In header mode it makes no request.

- **`detectBaseUrl()` / `BASE_URL_KEYS`** exported for debugging what the
  client resolved.

- **`globalThis.__API_BASE_URL__`** as a runtime base-URL override, for apps
  that load configuration after the bundle is built.

### Docs

Corrected every page that documented the broken behaviour as intended
(Storage Adapters, Web Worker Isolation, Core Concepts, Multi-Tab Sync,
Client Options). Added a Nuxt + httpOnly cookie recipe, a section on testing
against a real project, and Troubleshooting entries for each symptom above.

### Internal

Four new verification suites, all driving the real inlined worker bundle
through the real host protocol: `baseurl`, `storage`, `cookie-auth` and
`package`. The existing worker harness was made faithful to a real
`DedicatedWorkerGlobalScope` — its missing `importScripts` and
`BroadcastChannel` were what hid the cross-tab bug. 288 checks total.

## 1.0.1

Initial public release.
