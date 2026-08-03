# @mrzr/api-client

**The HTTP layer under TanStack Query, SWR and Vue Query — it handles authentication so they don't have to.**

A TypeScript-first API client focused on secure browser auth: coalesced token refresh, Web Worker token isolation, and cross-tab session sync. Zero runtime dependencies, works in every JS runtime.

```bash
npm install @mrzr/api-client
```

```ts
import { createClient } from "@mrzr/api-client";

export const api = createClient({ baseUrl: "https://api.example.com" });

// Tokens are captured, stored, refreshed and rotated across tabs for you.
await api.login({ email, password });
const { data } = await api.get<User[]>("/users");
```

---

## Is this for you?

Most HTTP clients treat auth as something you bolt on with interceptors. This one treats it as the product.

**Use it if** any of these are real problems for you:

- Your access token expires and 20 concurrent requests each fire their own refresh
- You want tokens off the main thread, where XSS can't read them
- Logging out in one tab should log out the others
- You use httpOnly cookies and can't tell on page load whether a session exists
- You need refresh to work *during* a five-minute file upload

**Use something else if not.** If you just want a small `fetch` wrapper, [**ky**](https://github.com/sindresorhus/ky) is excellent — a third of the size, built-in retry, and a lovely API. If you need broad legacy support and the biggest ecosystem, use axios. Neither is trying to solve browser auth, and this isn't trying to out-ky ky.

---

## How it compares

Verified, including the rows where this library loses.

| | axios | ky | @mrzr/api-client |
|---|---|---|---|
| Zero runtime dependencies | ✗ | ✓ | ✓ |
| Bundle, min+gzip | ~14 KB | **~4 KB** | 13.4 KB |
| Built on | XHR / node:http | fetch | fetch |
| Retry with backoff | via `axios-retry` | **✓ built in** | ✗ *(not yet)* |
| Interceptors / hooks | **✓ global** | **✓ global** | per-request transforms |
| **Coalesced token refresh** | build it yourself | build it yourself | **✓ built in** |
| **Web Worker token isolation** | ✗ | ✗ | **✓** |
| **Cross-tab auth sync** | ✗ | ✗ | **✓** |
| **httpOnly cookie session restore** | ✗ | ✗ | **✓** |
| **Cancel by URL pattern / scope** | ✗ | ✗ | **✓** |
| CSRF double-submit | partial | ✗ | ✓ |

Two honest notes on that table:

- **Size.** 13.4 KB is axios-territory and 3× ky. About 3.8 KB of it is the inlined worker, which ships even when you pass `worker: false` — a runtime flag can't be tree-shaken away. Worth knowing before you install.
- **Retry.** Not implemented. It has to interact correctly with refresh-and-retry, cancellation and `takeLatest`, and shipping it half-right would be worse than not shipping it.

---

## What it actually does

- **Coalesced refresh** — 50 simultaneous 401s trigger exactly **one** refresh call. A shared promise, not a polling loop
- **Web Worker isolation** — requests run in a worker by default, so tokens never enter the main-thread heap. Self-disables on the server or where `Worker` is missing
- **Cross-tab sync** — login, logout and refresh propagate over `BroadcastChannel`, with leader election so one tab drives
- **httpOnly cookie mode** — including `restoreSession()`, which answers the "am I logged in?" question that cookies make unanswerable from JS
- **Opt-in cancellation** — cancel by URL pattern, scope or key on page change or modal close; real aborts, worker mode included
- **Real upload support** — `FormData`, `File`, `Blob`, typed arrays and streams, with refresh handled mid-upload
- **CSRF double-submit** — built in, for cookie auth
- **One request engine** — the worker and main thread run the *same* compiled code, so behaviour can't drift between modes
- **Runs anywhere** — React, Vue, Svelte, Angular, Next.js, Nuxt, SvelteKit, plain `<script>`, Node 20+, Deno, Bun, Cloudflare Workers

---

## Works with your data library

It sits *under* TanStack Query, SWR or Vue Query — it doesn't replace them.

```ts
useQuery({
  queryKey: ["users"],
  queryFn: ({ signal }) => api.get<User[]>("/users", { signal }).then((r) => r.data),
});
```

Failures reject with a typed `ApiError`, which is what Query and SWR need to mark a request failed. Cancellation resolves instead, flagged with `canceled: true`, so a route change never looks like an error.

---

---

## 📚 Documentation

Full documentation lives in the **[Wiki](https://github.com/mohammadreza-zr/api-client/wiki)** — 26 pages covering every feature in depth.

| | |
|---|---|
| **Start here** | [Installation](https://github.com/mohammadreza-zr/api-client/wiki/Installation) · [Quick Start](https://github.com/mohammadreza-zr/api-client/wiki/Quick-Start) · [Core Concepts](https://github.com/mohammadreza-zr/api-client/wiki/Core-Concepts) |
| **Requests** | [Requests](https://github.com/mohammadreza-zr/api-client/wiki/Requests) · [Request Config](https://github.com/mohammadreza-zr/api-client/wiki/Request-Config) · [Cancellation](https://github.com/mohammadreza-zr/api-client/wiki/Cancellation) · [Responses & Errors](https://github.com/mohammadreza-zr/api-client/wiki/Responses-and-Errors) · [Uploads](https://github.com/mohammadreza-zr/api-client/wiki/Uploads-and-Binary-Bodies) |
| **Auth** | [Authentication](https://github.com/mohammadreza-zr/api-client/wiki/Authentication) · [Token Refresh](https://github.com/mohammadreza-zr/api-client/wiki/Token-Refresh) · [Storage](https://github.com/mohammadreza-zr/api-client/wiki/Storage-Adapters) · [CSRF](https://github.com/mohammadreza-zr/api-client/wiki/CSRF-Protection) |
| **Advanced** | [Worker Isolation](https://github.com/mohammadreza-zr/api-client/wiki/Web-Worker-Isolation) · [Multi-Tab Sync](https://github.com/mohammadreza-zr/api-client/wiki/Multi-Tab-Sync) · [Logging](https://github.com/mohammadreza-zr/api-client/wiki/Logging-and-Observability) · [Security Model](https://github.com/mohammadreza-zr/api-client/wiki/Security-Model) |
| **Reference** | [Client Options](https://github.com/mohammadreza-zr/api-client/wiki/Client-Options) · [API Reference](https://github.com/mohammadreza-zr/api-client/wiki/API-Reference) · [TypeScript Types](https://github.com/mohammadreza-zr/api-client/wiki/TypeScript-Types) |
| **Guides** | [Framework Recipes](https://github.com/mohammadreza-zr/api-client/wiki/Framework-Recipes) · [Cookbook](https://github.com/mohammadreza-zr/api-client/wiki/Cookbook) · [Migration](https://github.com/mohammadreza-zr/api-client/wiki/Migration-Guide) · [Troubleshooting](https://github.com/mohammadreza-zr/api-client/wiki/Troubleshooting) · [FAQ](https://github.com/mohammadreza-zr/api-client/wiki/FAQ) |

---

## Quick start

```ts
// lib/api.ts
import { createClient } from "@mrzr/api-client";

export const api = createClient({
  baseUrl: "https://api.example.com",
});
```

```ts
import { api } from "./lib/api";
import { ApiError } from "@mrzr/api-client";

try {
  const { data } = await api.get<User[]>("/users");
  console.log(data);
} catch (e) {
  if (e instanceof ApiError) console.error(e.statusCode, e.message);
}
```

That's it. Worker isolation, refresh and tab sync are on by default and degrade automatically where unsupported.

---

## Errors: throwing by default

**Failed requests reject with an `ApiError`.** This is the default because it is what every data-fetching library expects — TanStack Query, SWR and Vue Query all detect failure through a rejected promise, and it makes `await` behave the way you'd assume.

```ts
import { ApiError } from "@mrzr/api-client";

try {
  const { data } = await api.get<User>("/users/1");
} catch (e) {
  if (e instanceof ApiError) {
    e.statusCode; // 404
    e.errors;     // { email: ["already taken"] }
    e.response;   // the full envelope, if you want it
  }
}
```

### Prefer the never-throwing envelope?

Turn it off globally, per request, or both — per-request always wins.

```ts
const api = createClient({ throwError: false });     // envelope everywhere
const res = await api.get("/users");                 // never rejects
if (!res.status) console.error(res.message);

await api.get("/users", { throwError: true });       // …except this one
```

Successful responses always resolve with the same envelope:

```ts
interface IRes<R> {
  statusCode: number;              // 0 when the request never reached the network
  status: boolean;                 // true for 2xx
  message: string;
  data?: R;                        // unwrapped from { data: ... } automatically
  loading: boolean;
  errors?: Record<string, string[]>; // field-level validation errors
  error?: unknown;
  headers?: Record<string, string>;
}
```

---

## Authentication

### Header mode (default) — `Authorization: Bearer <token>`

```ts
const api = createClient({
  baseUrl: "https://api.example.com",
  authMode: "header",
  storage: "memory", // "memory" | "local" | "session" | "cookie"
});

await api.login({ email: "a@b.com", password: "secret" });
// tokens are stored internally; you never handle them

const me = await api.get<User>("/me");

await api.logout();
```

### Cookie mode — httpOnly cookies (most secure)

Your server sets `HttpOnly; Secure; SameSite` cookies. The client never sees a token.

```ts
const api = createClient({
  baseUrl: "https://api.example.com",
  authMode: "cookie", // sends credentials: "include", sets no Authorization header
});
```

### Seeding tokens (SSR, OAuth callback, existing login)

```ts
await api.setTokens({ accessToken, refreshToken });
```

### Reacting to auth changes

```ts
const stop = api.onAuthStateChange(({ isAuthenticated, expiresAt, user }) => {
  if (!isAuthenticated) router.push("/login");
});

const state = await api.getAuthState(); // never contains tokens
```

---

## Automatic token refresh

When a request returns **401**, the client refreshes and retries once — transparently.

```
Request A ─ 401 ─┐
Request B ─ 401 ─┼─→ ONE refresh call ─→ all three retried with the new token
Request C ─ 401 ─┘
```

Concurrent failures are coalesced into a single refresh (no stampede, no polling loop). The client also refreshes **proactively** when the JWT is about to expire, saving a wasted round trip:

Only a **server rejection** of the refresh ends the session — a 401/403 from the refresh endpoint clears auth in every tab and fires `onAuthFailure`. A **network failure** (offline, DNS, timeout) reports the refresh as failed without touching the session: a blip is not a logout, and the next request simply surfaces its 401 again.

```ts
createClient({ refreshSkewMs: 30_000 }); // default; 0 disables
```

Non-standard response shape? Map it yourself. Prefer the **declarative form**, which is plain data and therefore keeps Web Worker isolation:

```ts
createClient({
  refreshUrl: "/api/v1/auth/token/refresh/",
  buildRefreshBody: { field: "refresh_token" },   // → { refresh_token: "…" }
  extractTokens: {
    // body: { result: { jwt: "…", renew: "…", expires_in: 900 } }
    accessKeys: ["jwt"],
    refreshKeys: ["renew"],
    expiresInKeys: ["expires_in"],
    roots: ["result"],
  },
});
```

A **function** still works for arbitrary shapes — but a function cannot be structured-cloned into the request worker, so the function form silently falls back to main-thread mode. Only the declarative `TokenFieldMap` / `RefreshBodyConfig` forms keep worker isolation.

The default extractor already understands `access`/`refresh`, `access_token`/`refresh_token`, `accessToken`/`refreshToken`, and the same keys nested under `data`, `tokens` or `result`.

---

## Web Worker isolation

By default every request runs inside a Web Worker created from an inlined blob — **no extra file to host, no bundler config**.

- Tokens live in the worker's closure and are **never** posted to the main thread
- An XSS payload on your page cannot read `localStorage` or a JS variable to steal them
- Auth *state* (booleans, timestamps, `user`) crosses the boundary; tokens never do
- Even the `login()` response is stripped of its token fields before it resolves on the main thread — the extractor captures them into the worker's closure, and what your code receives is the rest of the payload (`user`, `message`, …)

It disables itself automatically during SSR, where `Worker` is unavailable, or when a CSP blocks blob workers — falling back to the identical main-thread implementation.

Two options disable it *only when passed as functions*, because a function cannot be structured-cloned across the boundary: **`extractTokens`** and **`buildRefreshBody`**. Their declarative forms — a `TokenFieldMap` and a `RefreshBodyConfig` — are plain data and keep worker isolation. A function form falls back to inline mode silently, so check `api.isWorker` at startup if that matters to you.

```ts
createClient({ worker: false }); // opt out
api.isWorker; // check which mode you got
```

> Worker isolation prevents token **theft**. It cannot stop an attacker who already has XSS from *using* your client to make requests. Combine it with a strong CSP.

---

## Multi-tab sync

Tabs coordinate over `BroadcastChannel`:

- One tab refreshes → the others adopt the new state instead of refreshing too
- One tab logs out → **every** tab clears immediately
- Tokens are never broadcast — only booleans and timestamps

```ts
createClient({ multiTab: false }); // opt out
```

Automatically disabled on the server.

---

## Request options

```ts
await api.get<User>("/users/{id}", {
  addTemplateToUrl: { id: 42 },        // /users/42
  addToUrl: ["posts", 7],              // /users/42/posts/7/
  params: { page: 1, filter: { active: true }, tags: ["a", "b"] },
  headers: { "X-Trace": "abc" },
  timeout: 5_000,
  baseUrl: "https://other.example.com", // override for this call
  skipAuth: true,                       // send without Authorization
  refreshTokenCheck: false,             // disable 401 → refresh → retry
  fullData: true,                       // don't unwrap { data: ... }
  hideErrorMessage: true,               // skip the onError callback
  throwError: false,                    // resolve with the envelope instead of rejecting
  uploadSkewMs: 600_000,                // refresh the token before a long upload
  duplex: "half",                       // for ReadableStream bodies (set automatically)
  log: true,                            // emit a structured log entry
  signal: controller.signal,            // your own AbortSignal — always honoured
  cancelable: true,                     // track it so api.cancel() can stop it
  cancelKey: "product-detail",           // a stable identity to cancel by name
  cancelGroup: "product-modal",          // a tag for bulk cancellation
  takeLatest: true,                     // supersede the previous request with this identity
  beforeFunc: (body) => body,           // transform outgoing body
  afterFunc: (data) => data,            // transform incoming data
});
```

Nested params serialize the way most REST backends expect:

```ts
{ name: "x", wallet: { balance: 0, tokens: ["BTC", "USDT"] } }
// → name=x&wallet[balance]=0&wallet[tokens]=BTC&wallet[tokens]=USDT
```

### Uploads and binary bodies

`FormData`, `File`/`Blob`, `ArrayBuffer`, typed arrays (`Uint8Array`, `DataView`, …), `URLSearchParams` and `ReadableStream` are detected and passed to `fetch` untouched — never JSON-stringified.

The default `Content-Type: application/json` is dropped for these bodies so the runtime can set the correct one (including the `multipart/form-data` boundary). An explicit per-request header always wins:

```ts
// multipart/form-data; boundary=… — set by the runtime
const form = new FormData();
form.append("file", fileInput.files[0]);
await api.post("/upload", form);

// application/octet-stream — from the Blob itself
await api.post("/upload", new Blob([bytes], { type: "application/octet-stream" }));

// image/png — your explicit header wins
await api.post("/upload", pngBytes, { headers: { "Content-Type": "image/png" } });
```

Uploads survive the `401 → refresh → retry` flow: the body is re-sent intact on the retry.

> Large uploads: the default 30s timeout applies per attempt. Pass `timeout: 0` to disable it for a specific call.

### Long uploads and token expiry

A 5-minute upload can outlive its access token. The client already retries a 401 by refreshing and re-sending the body, but re-uploading a large file is wasteful — and a `ReadableStream` cannot be replayed at all.

`uploadSkewMs` avoids the situation entirely by refreshing **before** the upload starts if the token would expire within the window you give it:

```ts
await api.post("/upload", form, {
  uploadSkewMs: 10 * 60_000, // "this may run for 10 minutes — refresh now if needed"
  timeout: 0,                // don't abort a slow upload
});
```

It only refreshes when the token actually falls inside the window, so short uploads pay nothing.

| Body type | Token expires mid-upload |
|---|---|
| `FormData`, `File`, `Blob`, `ArrayBuffer`, string | Refreshed and re-sent automatically |
| `ReadableStream` | Cannot be replayed — fails with a clear message telling you to retry (the token *has* been refreshed by then) |

Streams are single-use by nature, so prefer `uploadSkewMs` when streaming. Note that a `ReadableStream` also can't be transferred into a Web Worker — use `worker: false` for streamed uploads, or send a `Blob`/`File` instead.

---

## Cancelling requests

Stop in-flight requests when the user changes page, closes a modal, or types the next keystroke.

Cancellation is **opt-in** — nothing is tracked, and there's no bookkeeping cost, until you ask:

```ts
const api = createClient({ baseUrl, cancel: true });

// on route change — drop everything the old page started
router.events.on("routeChangeStart", () => api.cancel());
```

### Cancel by URL pattern

```ts
api.cancel();                      // everything in flight
api.cancel("/api/v1/products");    // just this screen's requests
```

Patterns are **segment-aware prefixes**, so one line covers a whole subtree without catching its neighbours:

| Pattern | Matches | Does **not** match |
|---|---|---|
| `/api/v1/products` | `/api/v1/products`, `/api/v1/products/12`, `/api/v1/products/12/reviews` | `/api/v1/products-archive` |
| `/api/v1/products$` | `/api/v1/products` | `/api/v1/products/12` |
| `/users/:id`, `/users/*` | `/users/7`, `/users/7/posts` | `/users`, `/orgs/7` |
| `/users/:id$` | `/users/7` | `/users/7/posts` |
| `/api/**/images` | `/api/images`, `/api/a/b/images` | `/other/images` |

Also accepted: a `RegExp`, an object (`{ url, method, key, group }`), or a predicate.

### Cancel by scope — modals and widgets

```ts
const scope = api.cancelScope("product-modal");

await scope.get("/api/v1/products/12");
await scope.get("/api/v1/products/12/reviews");

scope.cancel();   // when the modal closes
```

Scopes are self-enabling: requests made through one are cancelable even on a client that never set `cancel`.

### Cancel stale searches

```ts
await api.get("/search", { params: { q }, cancelKey: "search", takeLatest: true });
```

Each keystroke retires the previous request with the same key, so a fast typist can never be shown an older result.

### What you get back

A cancellation **resolves** — even under the default `throwError: true` — so the guard is one line and there's no `try`/`catch`:

```ts
const res = await api.get("/api/v1/products");
if (res.canceled) return;        // superseded or unmounted — not a failure
setProducts(res.data);
```

```ts
{ statusCode: 0, status: false, canceled: true, cancelReason: "left the page", … }
```

- **Cancellation never throws by default.** `throwOnCancel` is independent of `throwError`: real failures still reject. Rejecting a cancel makes TanStack Query **retry the request you just canceled** (measured: 2 server hits vs 1), and turns the ordinary `useEffect` async pattern into an unhandled rejection. Opt back in with `throwOnCancel: true`
- `onError` **never** fires for a cancellation — navigating away shouldn't raise a toast
- A timeout stays distinct: `408`, with `canceled` unset
- Only `GET` is tracked by default. A canceled write may already have been committed by the server, so writes opt in with `cancelable: true` or `cancel: { methods: "all" }`
- `login()`, `logout()` and the `restoreSession()` probe are never tracked, so a blanket `cancel()` can't abort the auth handshake
- Works identically in worker mode — the real `fetch` stops and the socket closes

```ts
api.pending();                  // inspect what's in flight
api.cancel("/x", "reason");     // returns how many it stopped
```

### With TanStack Query / SWR

Whoever owns the request lifecycle should own its cancellation. React Query hands your `queryFn` a `signal` — wire it through and it cancels on unmount and key change:

```ts
useQuery({
  queryKey: ["users"],
  queryFn: ({ signal }) => api.get<User[]>("/users", { signal }).then((r) => r.data),
});
```

`api.cancel()` still works on those requests, it's just rarely the better tool — react-query can't see it, so it caches the canceled envelope as success and may retry. Cancel a group with `queryClient.cancelQueries({ queryKey: ["product"] })` instead.

Mutations are the exception: react-query gives them **no** signal and doesn't cancel them on unmount, so a `cancelScope` is the right answer there. SWR likewise has no signal.

Full guide, with copy-paste recipes for React, Next, Vue, Svelte, Angular, TanStack Query and SWR: **[Cancellation](https://github.com/mohammadreza-zr/api-client/wiki/Cancellation)**.

---

## Client options

| Option | Default | Description |
|---|---|---|
| `baseUrl` | auto-detected | Falls back to `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_BASE_URL`, `VITE_API_URL`, `VITE_BASE_URL`, `NUXT_PUBLIC_API_URL`, `PUBLIC_API_URL`, `API_URL`, or `globalThis.__API_BASE_URL__`. Works in the browser, on the server, and in worker mode |
| `timeout` | `30000` | Per-request timeout in ms |
| `throwError` | `true` | Reject with `ApiError` on failure. Set `false` for the never-throwing envelope. Overridable per request |
| `headers` | `{}` | Merged into every request |
| `xsrfCookieName` | – | Cookie holding the CSRF token, mirrored into a header on unsafe methods |
| `xsrfHeaderName` | `"X-CSRF-Token"` | Header the CSRF token is sent under |
| `getCsrfToken` | – | Supplies the CSRF token directly. Required in worker mode |
| `authMode` | `"header"` | `"header"` or `"cookie"` |
| `credentials` | per mode | `"same-origin"`, or `"include"` in cookie mode |
| `cancel` | `false` | Opt in to cancellation. `true`, or `{ methods, throwOnCancel, takeLatest }` |
| `worker` | `true` | Run requests in a Web Worker |
| `multiTab` | `true` | Sync auth across tabs |
| `storage` | `"memory"` | `"memory" \| "local" \| "session" \| "cookie"`, or your own adapter |
| `storageKey` | `"apiclient"` | Prefix for persisted keys and the channel name |
| `loginUrl` / `refreshUrl` / `logoutUrl` | `/auth/login` etc. | Endpoint paths |
| `refreshSkewMs` | `30000` | Refresh this long before expiry; `0` disables |
| `extractTokens` | forgiving default | Map a response body onto tokens |
| `buildRefreshBody` | `{ refresh }` | Build the refresh request body |
| `onAuthStateChanged` | – | Auth state changed (never tokens) |
| `onAuthFailure` | – | Auth permanently lost |
| `onError` | – | Called for each failed request |
| `onLog` | `console.info` | Receives entries when `log: true` |

### CSRF protection

Cookie auth (`authMode: "cookie"`) means the browser attaches your session cookie to cross-site requests too, which is what makes CSRF possible. The standard defence is **double-submit**: the server sets a CSRF token in a readable cookie, and the client echoes it back in a header. An attacker's page can trigger a request but cannot read your cookie, so it cannot forge the header.

**Your backend still does the enforcement** — it has to compare the cookie against the header and reject mismatches. This client automates the browser half:

```ts
const api = createClient({
  authMode: "cookie",
  xsrfCookieName: "csrftoken",     // cookie your server sets
  xsrfHeaderName: "X-CSRF-Token",  // header to mirror it into (this is the default)
});

await api.post("/orders", body); // X-CSRF-Token attached automatically
```

Details worth knowing:

- Only `POST`, `PUT`, `PATCH` and `DELETE` get the header — `GET` is a safe method and is left alone.
- An explicit per-request header always wins, so you can override it anywhere.
- If the token is not in a readable cookie — a `<meta>` tag, an in-memory value, or **worker mode**, where `document.cookie` does not exist — supply it directly:

```ts
createClient({
  getCsrfToken: () => document.querySelector("meta[name=csrf]")?.content,
});
```

`getCsrfToken` is resolved on the main thread and forwarded with each request, so it works in worker mode where a cookie read would not.

### Storage and security

`"memory"` is the default and the safest: nothing survives a reload, and no script can read it. `"local"`, `"session"` and `"cookie"` persist across reloads but are readable by any script on the origin, so they are exposed to XSS. For the strongest setup use **cookie mode** with httpOnly cookies set by your server.

Custom adapter:

```ts
createClient({
  storage: {
    get: () => JSON.parse(myStore.read() ?? "null"),
    set: (tokens) => myStore.write(JSON.stringify(tokens)),
    clear: () => myStore.remove(),
  },
  // Worker mode is preserved: the adapter runs on the main thread and the
  // worker persists through it.
});
```

---

## Framework recipes

### TanStack Query

Works out of the box — failures reject, which is exactly what the library expects. No per-call flags needed.

```tsx
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@mrzr/api-client";
import { api } from "@/lib/api";

export const userKeys = {
  all: ["users"] as const,
  detail: (id: number) => [...userKeys.all, "detail", id] as const,
};

export function useUser(id: number) {
  return useQuery({
    queryKey: userKeys.detail(id),
    // `signal` wires react-query cancellation straight through to fetch
    queryFn: ({ signal }) =>
      api.get<User>("/users/{id}", { addTemplateToUrl: { id }, signal }),
    select: (res) => res.data,
    enabled: !!id,
    retry: (count, error) => {
      // Never retry client errors; ApiError carries the status code.
      if (error instanceof ApiError && error.statusCode < 500) return false;
      return count < 3;
    },
  });
}
```

`ApiError` exposes `statusCode`, `errors` (field-level validation), `data` and the full `response`, so error branches stay typed.

### SWR

```ts
import useSWR from "swr";
import { api } from "@/lib/api";

const { data, error, isLoading } = useSWR("/users", (url) =>
  api.get<User[]>(url).then((r) => r.data),
);
```

Because the client rejects on failure, `error` is a real `ApiError` and SWR's built-in retry works as designed.

### Next.js (App Router)

```ts
// Server component / route handler — worker is skipped automatically
import { createClient } from "@mrzr/api-client";
import { cookies } from "next/headers";

export async function getUsers() {
  const api = createClient({ baseUrl: process.env.API_URL, worker: false });
  const token = (await cookies()).get("access_token")?.value;
  if (token) await api.setTokens({ accessToken: token });

  const { data } = await api.get<User[]>("/users", { cache: "no-store" });
  api.destroy();
  return data;
}
```

### Vue / Nuxt

```ts
export const api = createClient({ baseUrl: import.meta.env.VITE_API_URL });

const users = ref<User[]>([]);
const error = ref<string>();

onMounted(async () => {
  try {
    const { data } = await api.get<User[]>("/users");
    users.value = data ?? [];
  } catch (e) {
    error.value = (e as ApiError).message;
  }
});
```

Prefer no try/catch in components? Create the client with `throwError: false` and branch on `res.status` instead.

### Plain browser

```html
<script type="module">
  import { createClient } from "https://esm.sh/@mrzr/api-client";
  const api = createClient({ baseUrl: "https://api.example.com" });
  console.log((await api.get("/health")).data);
</script>
```

---

## API reference

```ts
api.get<R>(url, config?)
api.post<R>(url, body?, config?)
api.put<R>(url, body?, config?)
api.patch<R>(url, body?, config?)
api.delete<R>(url, config?)

api.login<R>(body, config?)      // authenticate + store tokens
api.logout<R>(config?)           // clear tokens everywhere
api.setTokens({ accessToken, refreshToken, expiresAt? })
api.refresh()                    // force a refresh; true / false. Never the
                                 // token — it stays in the worker (or store)
api.getAuthState()               // { isAuthenticated, expiresAt, user }
api.restoreSession("/api/auth/me") // cookie mode: detect an existing session on boot
api.onAuthStateChange(listener)  // returns unsubscribe

api.cancel(selector?, reason?)   // cancel in-flight requests; returns how many
api.pending(selector?)           // inspect what's in flight
api.cancelScope("modal")         // a wrapper whose requests cancel together

api.isWorker                     // whether requests run in a worker
api.destroy()                    // terminate worker + close channel
```

Also exported: `ApiError`, `buildQueryString`, `getTokenExpiry`, `isTokenExpired`, `MemoryStorage`, `WebStorage`, `CookieStorage`, and all types.

---

## Migrating to throwing errors

`throwError` now defaults to `true`, so failed requests reject instead of resolving. If you have existing code written against the envelope, restore the old behaviour in one line:

```ts
export const api = createClient({ baseUrl: "…", throwError: false });
```

Everything else is unchanged. To adopt the new default instead, replace `status` checks with `try/catch`:

```ts
// before
const res = await api.get("/users");
if (!res.status) return handle(res.message);
use(res.data);

// after
try {
  const { data } = await api.get("/users");
  use(data);
} catch (e) {
  handle((e as ApiError).message);
}
```

## Requirements

Any runtime with `fetch` and `AbortController`: all modern browsers, Node 20+, Deno, Bun, Cloudflare Workers.

## License

MIT
