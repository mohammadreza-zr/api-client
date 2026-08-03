# FAQ

---

### Why another HTTP client?

Because the boring parts are always rewritten by hand. Token refresh with proper concurrency control, cross-tab logout, upload content-type handling, nested query params — every project reimplements them, usually with a race condition in the refresh queue. This packages them, with zero dependencies and no bundler configuration.

### How big is it?

~13 KB min+gzip for the full bundle, including the inlined worker. It's `sideEffects: false`, so importing only `buildQueryString` pulls in almost nothing (~0.4 KB).

### Does it work without a bundler?

Yes:

```html
<script type="module">
  import { createClient } from "https://esm.sh/@mrzr/api-client";
</script>
```

### Does it work in Node / Deno / Bun / Cloudflare Workers?

Yes — anything with `fetch` and `AbortController`. Worker isolation and tab sync self-disable there.

### How do I cancel requests when the user changes page?

Enable cancellation once, then call `cancel()`:

```ts
const api = createClient({ baseUrl, cancel: true });
router.on("navigate", () => api.cancel());
```

Narrow it with a URL pattern (`api.cancel("/api/v1/products")`), a `cancelScope` for a modal, or `takeLatest` for a search box. It is opt-in, and covers `GET` only unless you widen `methods` — a canceled write may already have been committed by the server. See **[[Cancellation]]**.

### Do I need to configure the Web Worker?

No. It's compiled to a string and instantiated from a blob at runtime — no separate file, no `?worker` import, no bundler plugin. The only requirement is a CSP that permits `worker-src blob:`.

### Should I create one client or many?

**One per API.** Each client owns a worker and a BroadcastChannel. Multiple APIs? Multiple clients with distinct `storageKey`s. On the server, create one per request and `destroy()` it.

### Can I use it with React Query / SWR?

Yes, and it's designed for it — failures reject with a typed `ApiError`, which is what both libraries expect. See [[Framework Recipes]].

### Why does `throwError` default to `true`?

Because with `false`, a 500 arrives as a *successful* result and React Query caches it as data — no error UI, no retry. Throwing is what every data-fetching library expects. The envelope style is one flag away.

### How do I get the old never-throwing behaviour?

```ts
createClient({ throwError: false });
```

### Does it retry failed requests?

Only the `401 → refresh → retry` flow, exactly once. Everything else is your policy — see the backoff recipe in [[Cookbook]]. Retries have security and idempotency implications, so they aren't a default.

### What happens if 50 requests get a 401 simultaneously?

Exactly **one** refresh call. `AuthStore.coalesceRefresh` hands every concurrent caller the same promise. No polling, no stampede.

### Are tokens really never on the main thread?

In worker mode with `storage: "memory"`: yes. They live in the worker's closure, and only `AuthState` (booleans, timestamps, `user`) crosses the boundary. Even the `login()` response — which usually contains the tokens — is stripped of its token fields before it resolves on the main thread. With `storage: "local"` the persisted copy is readable by page scripts regardless of worker mode. One caveat: the **function** forms of `extractTokens` and `buildRefreshBody` cannot cross the boundary, so passing a function disables worker mode (inline fallback) — the declarative `TokenFieldMap` / `RefreshBodyConfig` forms keep it.

### Does worker isolation stop XSS?

No. It stops token **theft**, not token **use**. An attacker with XSS can still call your client. It shrinks the blast radius from "indefinite account access" to "access while the tab is open". Prevent XSS with a strict CSP first. See [[Security Model]].

### `localStorage` or cookies?

httpOnly cookies (`authMode: "cookie"`) if you control the backend and share a site. Otherwise header mode with `storage: "memory"` and worker isolation. `"local"` only when persistence outweighs the XSS exposure. See [[Storage Adapters]].

### How do I keep users signed in across reloads without `localStorage`?

Have your server set a long-lived **httpOnly refresh cookie**, keep `storage: "memory"`, and call `api.refresh()` on boot. You get persistence with no readable token.

### Does it support GraphQL?

Not specially, but GraphQL is just a POST:

```ts
const { data } = await api.post<{ data: T }>("/graphql", { query, variables }, { fullData: true });
```

You lose GraphQL-specific error handling; a dedicated client is better for a GraphQL-first app.

### Can I track upload progress?

Not directly — `fetch` has no upload-progress event, so no `fetch`-based client can. Chunk the upload and count chunks, wrap the body in a counting `ReadableStream` (with `worker: false`), or use `XMLHttpRequest` for uploads only. See [[Uploads and Binary Bodies]].

### Does it support Server-Sent Events or WebSockets?

No. Use `EventSource` and `WebSocket` directly — they're different protocols with different lifecycles.

### Can I intercept requests like axios?

There are no interceptors, but the equivalents exist: `headers`, `beforeFunc`, `afterFunc`, `onError`, `onLog`, and built-in auth. See the mapping in [[Migration Guide]].

### Why do custom functions disable worker mode?

Functions can't be structured-cloned across a `postMessage` boundary. `extractTokens` and `buildRefreshBody` run inside the request pipeline, so a **function** form must live where the pipeline does and disables worker mode. Both have declarative forms — `TokenFieldMap` / `RefreshBodyConfig` — that are plain data and keep worker mode on. Other function options (`getCsrfToken`, `beforeFunc`, `afterFunc`, callbacks) run on the host and keep worker mode.

### How do I know which mode I'm in?

```ts
api.isWorker;
```

### Does it verify JWT signatures?

No, and it shouldn't. Verification requires the server's secret; doing it client-side is security theatre. The client only *reads* the `exp` claim to schedule refreshes.

### What if my tokens aren't JWTs?

Opaque tokens work fine. The client can't predict their expiry, so proactive refresh is skipped and the `401 → refresh → retry` path handles it. Supply `expiresAt` in `setTokens` if you know it.

### How do I handle multiple auth realms?

Separate clients with separate `storageKey`s:

```ts
export const userApi  = createClient({ storageKey: "user" });
export const adminApi = createClient({ storageKey: "admin" });
```

### Does it work with Django / Laravel / Rails / Spring?

Yes. The default token extractor covers DRF and SimpleJWT out of the box, and CSRF cookie/header names are configurable for all of them. See [[Client Options]] and [[CSRF Protection]].

### Why is `res.data` optional?

Because a 204, an empty body, or a parse failure legitimately produces no payload. Narrow with `res.status`, or use the type guard in [[TypeScript Types]].

### Why is `status` a boolean and not a number?

`statusCode` is the number; `status` is the 2xx boolean. It reads well at call sites (`if (!res.status)`) — but it's the number one gotcha when migrating from axios.

### Can I use it in React Native?

Yes, with `worker: false`, `multiTab: false`, and a custom storage adapter over `AsyncStorage` or `expo-secure-store`. See [[Storage Adapters]].

### How do I test code that uses it?

Mock `globalThis.fetch`, or use MSW. Always construct test clients with `worker: false, multiTab: false`. See [[Cookbook]].

### Is it production ready?

It ships with 121 verification assertions covering the request engine, worker parity, uploads, React Query and SWR integration, `throwError` semantics, long-upload token expiry and CSRF — all run against real HTTP servers, not mocks. Run them yourself with `npm run verify`.

### What's the versioning policy?

Semantic versioning. Breaking changes to `ClientOptions`, `RequestConfig`, `IRes` or `ApiClient` are major.

### How do I report a security issue?

Open a [security advisory](https://github.com/mohammadreza-zr/api-client/security/advisories/new), not a public issue.

### Can I contribute?

Yes — see [[Contributing]].
