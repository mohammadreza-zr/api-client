# @mohammadreza-zr/api-client

A typed REST client built on `fetch` with **zero runtime dependencies**.

Automatic token refresh, Web Worker isolation so tokens never touch the main thread, and cross-tab auth sync — in one `createClient()` call that works the same everywhere.

```bash
npm install @mohammadreza-zr/api-client
```

- **Zero dependencies** — nothing but the platform `fetch`
- **Runs anywhere** — React, Vue, Svelte, Angular, Next.js, Nuxt, SvelteKit, plain `<script>`, Node, SSR/SSG/SPA
- **One request engine** — the worker and main thread run the *same* code, so behaviour can never drift
- **Concurrency-safe refresh** — 50 simultaneous 401s trigger exactly **one** refresh call
- **Never throws by default** — every call resolves with a predictable envelope
- **~13 KB** min+gzip, tree-shakeable, ESM + CJS + full types

---

## Quick start

```ts
// lib/api.ts
import { createClient } from "@mohammadreza-zr/api-client";

export const api = createClient({
  baseUrl: "https://api.example.com",
});
```

```ts
import { api } from "./lib/api";

const { data, status, message } = await api.get<User[]>("/users");

if (status) console.log(data);
else console.error(message);
```

That's it. Worker isolation, refresh and tab sync are on by default and degrade automatically where unsupported.

---

## The response envelope

Every method resolves with the same shape — no try/catch needed.

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

Prefer exceptions (e.g. for React Query)? Opt in per request:

```ts
import { ApiError } from "@mohammadreza-zr/api-client";

try {
  const { data } = await api.get<User>("/users/1", { throwError: true });
} catch (e) {
  if (e instanceof ApiError) {
    console.log(e.statusCode, e.errors);
  }
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
  throwError: true,                     // reject instead of resolving
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

---

## Client options

| Option | Default | Description |
|---|---|---|
| `baseUrl` | auto-detected | Falls back to `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_BASE_URL`, `VITE_API_URL`, `VITE_BASE_URL`, `NUXT_PUBLIC_API_URL`, `API_URL` |
| `timeout` | `30000` | Per-request timeout in ms |
| `throwError` | `false` | Reject with `ApiError` on failure instead of resolving. **Set `true` for TanStack Query / SWR.** Overridable per request |
| `headers` | `{}` | Merged into every request |
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

### TanStack Query / SWR — set `throwError: true`

These libraries decide success or failure by whether the promise **rejects**. By default this client never rejects: it resolves with `{ status: false, statusCode: 500 }`. That means **a failed request would be cached as successful data**, `isError` would stay `false`, and retries would never fire.

Enable rejection once, on the client:

```ts
// lib/api.ts
export const api = createClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL,
  throwError: true, // failures reject with ApiError — required for react-query/SWR
});
```

Individual calls can still opt out with `throwError: false` when you want the envelope.

```tsx
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@mohammadreza-zr/api-client";
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
import { createClient } from "@mohammadreza-zr/api-client";
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
onMounted(async () => {
  const res = await api.get<User[]>("/users");
  if (res.status) users.value = res.data ?? [];
});
```

### Plain browser

```html
<script type="module">
  import { createClient } from "https://esm.sh/@mohammadreza-zr/api-client";
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

## Requirements

Any runtime with `fetch` and `AbortController`: all modern browsers, Node 18+, Deno, Bun, Cloudflare Workers.

## License

MIT
