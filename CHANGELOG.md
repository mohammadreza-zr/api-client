# Changelog

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
