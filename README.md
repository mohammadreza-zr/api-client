# @mrzr/api-client

A typed REST client built on `fetch` with **zero runtime dependencies**.

Automatic token refresh, Web Worker isolation so tokens never touch the main thread, and cross-tab auth sync — in one `createClient()` call that works the same everywhere.

```bash
npm install @mrzr/api-client
```

- **Zero dependencies** — nothing but the platform `fetch`
- **Runs anywhere** — React, Vue, Svelte, Angular, Next.js, Nuxt, SvelteKit, plain `<script>`, Node, SSR/SSG/SPA
- **One request engine** — the worker and main thread run the *same* code, so behaviour can never drift
- **Concurrency-safe refresh** — 50 simultaneous 401s trigger exactly **one** refresh call
- **Drop-in for TanStack Query / SWR** — failures reject with a typed `ApiError`, or switch to a never-throwing envelope with one flag
- **Real upload support** — `FormData`, `File`, `Blob`, typed arrays and streams, with token refresh handled mid-upload
- **CSRF double-submit** built in, for cookie auth
- **~10 KB** min+gzip, tree-shakeable, ESM + CJS + full types

---

## 📚 Documentation

Full documentation lives in the **[Wiki](https://github.com/mohammadreza-zr/api-client/wiki)** — 25 pages covering every feature in depth.

| | |
|---|---|
| **Start here** | [Installation](https://github.com/mohammadreza-zr/api-client/wiki/Installation) · [Quick Start](https://github.com/mohammadreza-zr/api-client/wiki/Quick-Start) · [Core Concepts](https://github.com/mohammadreza-zr/api-client/wiki/Core-Concepts) |
| **Requests** | [Requests](https://github.com/mohammadreza-zr/api-client/wiki/Requests) · [Request Config](https://github.com/mohammadreza-zr/api-client/wiki/Request-Config) · [Responses & Errors](https://github.com/mohammadreza-zr/api-client/wiki/Responses-and-Errors) · [Uploads](https://github.com/mohammadreza-zr/api-client/wiki/Uploads-and-Binary-Bodies) |
| **Auth** | [Authentication](https://github.com/mohammadreza-zr/api-client/wiki/Authentication) · [Token Refresh](https://github.com/mohammadreza-zr/api-client/wiki/Token-Refresh) · [Storage](https://github.com/mohammadreza-zr/api-client/wiki/Storage-Adapters) · [CSRF](https://github.com/mohammadreza-zr/api-client/wiki/CSRF-Protection) |
| **Advanced** | [Worker Isolation](https://github.com/mohammadreza-zr/api-client/wiki/Web-Worker-Isolation) · [Multi-Tab Sync](https://github.com/mohammadreza-zr/api-client/wiki/Multi-Tab-Sync) · [Logging](https://github.com/mohammadreza-zr/api-client/wiki/Logging-and-Observability) · [Security Model](https://github.com/mohammadreza-zr/api-client/wiki/Security-Model) |
| **Reference** | [Client Options](https://github.com/mohammadreza-zr/api-client/wiki/Client-Options) · [API Reference](https://github.com/mohammadreza-zr/api-client/wiki/API-Reference) · [TypeScript Types](https://github.com/mohammadreza-zr/api-client/wiki/TypeScript-Types) |
| **Guides** | [Framework Recipes](https://github.com/mohammadreza-zr/api-client/wiki/Framework-Recipes) · [Cookbook](https://github.com/mohammadreza-zr/api-client/wiki/Cookbook) · [Migration](https://github.com/mohammadreza-zr/api-client/wiki/Migration-Guide) · [Troubleshooting](https://github.com/mohammadreza-zr/api-client/wiki/Troubleshooting) · [FAQ](https://github.com/mohammadreza-zr/api-client/wiki/FAQ) |

The source for these pages is in [`wiki/`](./wiki) — edit there and run `./scripts/sync-wiki.sh` to publish.

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

```ts
createClient({ refreshSkewMs: 30_000 }); // default; 0 disables
```

Non-standard response shape? Map it yourself:

```ts
createClient({
  refreshUrl: "/api/v1/auth/token/refresh/",
  buildRefreshBody: (refresh) => ({ refresh_token: refresh }),
  extractTokens: (body) => ({
    accessToken: body.result.jwt,
    refreshToken: body.result.renew,
  }),
});
```

The default extractor already understands `access`/`refresh`, `access_token`/`refresh_token`, `accessToken`/`refreshToken`, and the same keys nested under `data`, `tokens` or `result`.

---

## Web Worker isolation

By default every request runs inside a Web Worker created from an inlined blob — **no extra file to host, no bundler config**.

- Tokens live in the worker's closure and are **never** posted to the main thread
- An XSS payload on your page cannot read `localStorage` or a JS variable to steal them
- Auth *state* (booleans, timestamps, `user`) crosses the boundary; tokens never do

It disables itself automatically during SSR, where `Worker` is unavailable, or when a CSP blocks blob workers — falling back to the identical main-thread implementation.

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

## Client options

| Option | Default | Description |
|---|---|---|
| `baseUrl` | auto-detected | Falls back to `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_BASE_URL`, `VITE_API_URL`, `VITE_BASE_URL`, `NUXT_PUBLIC_API_URL`, `API_URL` |
| `timeout` | `30000` | Per-request timeout in ms |
| `throwError` | `true` | Reject with `ApiError` on failure. Set `false` for the never-throwing envelope. Overridable per request |
| `headers` | `{}` | Merged into every request |
| `xsrfCookieName` | – | Cookie holding the CSRF token, mirrored into a header on unsafe methods |
| `xsrfHeaderName` | `"X-CSRF-Token"` | Header the CSRF token is sent under |
| `getCsrfToken` | – | Supplies the CSRF token directly. Required in worker mode |
| `authMode` | `"header"` | `"header"` or `"cookie"` |
| `credentials` | per mode | `"same-origin"`, or `"include"` in cookie mode |
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
  worker: false, // custom adapters can't cross the worker boundary
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
api.refresh()                    // force a refresh; null on failure
api.getAuthState()               // { isAuthenticated, expiresAt, user }
api.onAuthStateChange(listener)  // returns unsubscribe
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

Any runtime with `fetch` and `AbortController`: all modern browsers, Node 18+, Deno, Bun, Cloudflare Workers.

## License

MIT
