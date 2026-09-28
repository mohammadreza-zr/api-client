# Changelog

## Unreleased

A security and correctness pass. Every fix below has a regression test in
`verify/regressions.mjs` or `verify/regressions-worker.mjs` that fails on
2.0.0.

### Security

- **The access token was sent to any origin.** An absolute URL or a
  per-request `baseUrl` received `Authorization: Bearer …`, so a third-party
  URL — or one injected by XSS, defeating worker isolation — could read the
  token. The token and the CSRF header now go only to the `baseUrl` origin
  and origins listed in the new `authOrigins` option.
- **URL values could rewrite the path.** `addTemplateToUrl` and `addToUrl`
  values are now encoded as one path segment: `{ id: "1/../admin?x=" }` no
  longer reaches `/admin?x=`. Template substitution is single-pass.
- **A tab without a session could log every other tab out**, and tabs with a
  rotating refresh token could spend it twice (the server reads that as reuse
  and revokes the session). Tabs now take turns refreshing through the Web
  Locks API and adopt a sibling's fresh tokens instead of refreshing again. A
  failed refresh only logs other tabs out when they share the session.
- **The refresh request never sent the CSRF header**, so a CSRF-protected
  refresh endpoint answered 403 and the user was logged out. In worker mode,
  `login()` and `logout()` also skipped it. The worker now asks the host for
  the token, so CSRF behaves identically in both modes.

### Fixed

- `logout()` could be undone by a refresh that was already in flight.
- A refresh endpoint that never answered froze every request, whatever
  `timeout` was set to. The refresh now has the client timeout.
- In worker mode `api.refresh()` always resolved `true`, even when the
  refresh was rejected.
- `login()` kept the previous user's refresh token and `user` when the new
  response didn't carry them.
- `isAuthenticated` was `false` after a reload with an expired access token
  and a valid refresh token, so apps redirected to login needlessly.
- `setTokens({ accessToken: undefined })` did nothing; it now clears the
  token, as documented.
- A new opaque (non-JWT) token inherited the previous token's expiry.
- Cookie mode: a 403 marked the user as signed out, and so did a network
  failure during refresh.
- `afterFunc` / `beforeSelectOptions` ran on error responses; a transform
  written for the success shape crashed and replaced a 404 with `statusCode:
  0`. They now run on success only, and a crashing transform keeps the HTTP
  status.
- Binary responses (files, images, PDFs) were decoded as text and corrupted.
- The timeout stopped at the response headers; a stalled body hung forever.
- `CookieStorage` silently lost token pairs over the ~4 KB cookie limit; large
  values are now split across several cookies.
- Worker mode: a worker blocked at boot (for example by a CSP `worker-src`
  rule, which browsers report asynchronously) failed every request. It now
  falls back to the main thread, like `worker: false`; `isWorker` reports it.
- Worker mode: `destroy()` during boot left pending calls hanging forever
  (React StrictMode, HMR).
- Worker mode: a relative `baseUrl` such as `"/api"` could not resolve inside
  the worker.
- Worker mode: a throwing `beforeFunc` rejected with a raw error instead of
  resolving like main-thread mode, and a worker failure was reported as a
  fake HTTP 500.
- Worker mode: `login()` stripped non-token fields that share a token key name,
  such as `user.access: ["admin"]`.
- Using the client with no `baseUrl` on the server (Node, SSR, tests) failed
  with `Failed to parse URL from /users`. It now fails with a message naming
  the option and the env variables to set.

### Added

- **WebSockets / socket.io.** `api.getSocketToken(url)` fetches a socket
  credential from your server through the authenticated client, so the
  access token never leaves the worker. For socket servers that accept the
  API token itself, `api.getAccessToken()` returns it (refreshed if about to
  expire) behind the new `exposeTokens: true` option.
- `authOrigins`, `responseType` and `IRes.body` (see below).

### Changed

- **`baseUrl` defaults:** the explicit option, else an env variable, else the
  page origin in a browser or worker. Detection adds `NEXT_PUBLIC_API_BASE_URL`,
  `VITE_API_BASE_URL`, `REACT_APP_API_URL`, `EXPO_PUBLIC_API_URL`,
  `PUBLIC_API_BASE_URL` and `API_BASE_URL`.
- **`Content-Type` is only sent with a body.** A GET or DELETE no longer
  carries `application/json`, which forced a CORS preflight on every
  cross-origin read.
- **Non-textual responses resolve as a `Blob`** (`responseType: "auto"`).
  Use the new `responseType` option (`"json" | "text" | "blob" |
  "arrayBuffer"`) to choose.
- When `data` is unwrapped from `{ data }`, the whole payload is kept on the
  new `IRes.body`, so siblings such as pagination `meta` stay reachable.
- `getCsrfToken` may return a promise.

### Upgrading

- A request to another origin that relied on receiving the token needs that
  origin in `authOrigins`.
- `addToUrl: ["a/b"]` used to produce two path segments; it now produces one
  (`a%2Fb`).
- Code that read a binary response as a string should read the `Blob`, or pass
  `responseType: "text"`.

## 2.0.0 - 2026-08-03

### Breaking

- **`api.refresh()` now returns `Promise<boolean>`** instead of the new
  access token (`string`) or `null`. The token never leaves the worker (and
  was returned as `""` there), and `true`/`false` is all a caller can act on:

  ```ts
  // before
  const token = await api.refresh();
  if (token === null) redirectToLogin();

  // after
  const ok = await api.refresh();
  if (!ok && !(await api.getAuthState()).isAuthenticated) redirectToLogin();
  ```

  `TokenExtractor` and `buildRefreshBody` functions still work — see below.

- **`extractTokens` / `buildRefreshBody` now accept declarative forms** in
  addition to functions: `TokenFieldMap` and `RefreshBodyConfig`. The
  function forms still work unchanged. See "Added".

### Added

- **Declarative, worker-safe token mapping.** `extractTokens` accepts a
  `TokenFieldMap` (`accessKeys`, `refreshKeys`, `expiryKeys`,
  `expiresInKeys`, `roots`) and `buildRefreshBody` accepts a
  `RefreshBodyConfig` (`field`). Because these are plain data they can be
  structured-cloned into the request worker — custom response shapes no
  longer force the client out of worker isolation:

  ```ts
  createClient({
    extractTokens: { accessKeys: ["jwt"], refreshKeys: ["renew"], roots: ["result"] },
    buildRefreshBody: { field: "refresh_token" },
  });
  ```

  The **function** forms still disable worker mode (a function cannot be
  cloned across the boundary) — the previous documented behaviour.

- **A crashed request worker no longer hangs requests.** The host now
  handles `Worker.onerror`: in-flight calls reject with an actionable
  message instead of never settling, subsequent calls fail fast, and when
  tokens are recoverable (persistent storage lives on the host) the worker
  is restarted once automatically and re-hydrates the session. With the
  default `storage: "memory"` the session lived in the worker's closure and
  is lost with it — the client says so clearly instead of hanging.

### Fixed

- **A network blip or server error during refresh no longer logs out every
  tab.** Only an **authentication rejection** of the refresh (a 401/403
  response) clears auth, broadcasts logout and fires `onAuthFailure` — that
  is the server saying the user is not authenticated. A network failure
  (offline, DNS, timeout) or a server error (5xx, rate-limit) now reports
  the refresh as failed while leaving the session intact — the request that
  hit the 401 surfaces as 401, and the user stays signed in when things
  recover.

- **Worker mode: the `login()` response no longer carries tokens to the main
  thread.** The response body that contains the tokens was posted back inside
  `result.data`, so an XSS payload on the page could read them straight off
  the resolved promise — contradicting the isolation guarantee. Token fields
  are now stripped before the envelope crosses the boundary; the extractor
  still captures them into the worker's closure. (`fullData` included.)

- **Cookie mode: a 2xx from a public endpoint no longer marks the user as
  authenticated.** Any successful request (e.g. a public `/products` call made
  while logged out) flipped `isAuthenticated` to `true`, because the session
  flag was inferred from *any* 2xx. The positive direction is now asserted
  only where the server's answer means it — `login()`, a successful
  `refresh()`, and the `restoreSession()` probe. A 401/403 that survives the
  retry flow still clears the flag.

- **Timeouts are reported as `408` even when the engine drops the abort
  reason.** Safari (WebKit bug 246069, still open in 18.x) rejects an
  in-flight abort with a bare `AbortError` and discards the `TimeoutError`
  reason, so a timeout was classified as a cancellation: it resolved silently
  with `canceled: true` instead of throwing/408, and `onError` never fired.
  The engine now classifies from the abort signal it handed to `fetch`, which
  is authoritative on every engine (this also makes caller-supplied
  `AbortSignal.timeout()` signals report 408).

- **`onAuthStateChange` no longer fires immediately in worker mode** with a
  stale `{ isAuthenticated: false }` snapshot before the worker has finished
  hydrating (inline mode never fired immediately). Use `getAuthState()` for
  the current snapshot. Worker and inline modes now behave identically.

### Docs

- `extractTokens` and `buildRefreshBody` disable worker mode (functions can't
  be structured-cloned) — now called out in the README.
- `api.refresh()` return value documented for worker mode (`""` on success:
  the token never leaves the worker).

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
