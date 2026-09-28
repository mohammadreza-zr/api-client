# Client Options

Everything `createClient(options)` accepts.

```ts
import { createClient } from "@mrzr/api-client";

const api = createClient({ /* ClientOptions */ });
```

---

## Full table

| Option | Type | Default | Description |
|---|---|---|---|
| **Connection** ||||
| `baseUrl` | `string` | auto-detected | Prefix for relative URLs. Trailing slashes are normalized. See below |
| `plugins` | `ApiPlugin[]` | `[]` | Optional add-ons, applied in order. See [[Plugins]] |
| `exposeTokens` | `boolean` | `false` | Allow `api.getAccessToken()`, for a socket server that accepts the API token. Lets page code read the token; prefer `getSocketToken`. See [[WebSockets and Socket.io]] |
| `authOrigins` | `string[]` | `[]` | Extra origins allowed to receive the access token and CSRF header. The `baseUrl` origin and the page's own origin are always allowed; every other URL is sent without them. URLs are resolved the way `fetch` resolves them before the check, so `//host`, `\\host` and `/\host` count as that host |
| `timeout` | `number` | `30000` | Per-attempt timeout in ms; `0` disables |
| `headers` | `Record<string, string>` | `{}` | Merged into every request |
| `credentials` | `RequestCredentials` | per `authMode` | `"same-origin"`, or `"include"` in cookie mode |
| **Errors** ||||
| `throwError` | `boolean` | `true` | Reject with `ApiError` on failure. `false` for the envelope |
| `onError` | `(res: IRes) => void` | – | Called for each failed request unless `hideErrorMessage` |
| **Auth** ||||
| `authMode` | `"header" \| "cookie"` | `"header"` | How credentials are attached |
| `storage` | `StorageKind \| TokenStorage` | `"memory"` | Where tokens persist (header mode only) |
| `storageKey` | `string` | `"apiclient"` | Prefix for storage keys and the tab channel |
| `loginUrl` | `string` | `"/auth/login"` | Login endpoint |
| `refreshUrl` | `string` | `"/auth/refresh"` | Refresh endpoint |
| `logoutUrl` | `string` | `"/auth/logout"` | Logout endpoint |
| `refreshSkewMs` | `number` | `30000` | Refresh this long before expiry; `0` disables |
| `extractTokens` | `TokenExtractor` | forgiving default | Map a response body onto tokens |
| `buildRefreshBody` | `(refresh?: string) => unknown` | `{ refresh }` | Build the refresh request body |
| `onAuthStateChanged` | `(state: AuthState) => void` | – | Auth state changed. Never receives tokens |
| `onAuthFailure` | `() => void` | – | Auth permanently lost |
| **CSRF** ||||
| `xsrfCookieName` | `string` | – | Cookie holding the CSRF token |
| `xsrfHeaderName` | `string` | `"X-CSRF-Token"` | Header to mirror it into |
| `getCsrfToken` | `() => string \| undefined \| Promise<…>` | – | Supply the token directly. Takes precedence |
| **Cancellation** ||||
| `cancel` | `boolean \| CancelOptions` | `false` | Opt in to cancellation. See [[Cancellation]] |
| **Execution** ||||
| `worker` | `boolean` | `true` | Run requests in a Web Worker |
| `multiTab` | `boolean` | `true` | Sync auth across tabs via BroadcastChannel |
| **Logging** ||||
| `onLog` | `(entry: LogEntry) => void` | `console.info` | Receives entries when a request sets `log: true` |

---

## `baseUrl` auto-detection

When omitted, the first environment variable that is set wins, in this order:

1. `NEXT_PUBLIC_API_URL`
2. `NEXT_PUBLIC_API_BASE_URL`
3. `NEXT_PUBLIC_BASE_URL`
4. `VITE_API_URL`
5. `VITE_API_BASE_URL`
6. `VITE_BASE_URL`
7. `NUXT_PUBLIC_API_URL`
8. `REACT_APP_API_URL`
9. `EXPO_PUBLIC_API_URL`
10. `PUBLIC_API_URL`
11. `PUBLIC_API_BASE_URL`
12. `API_URL`
13. `API_BASE_URL`

Vite's own `BASE_URL` is deliberately not read: it is the app's public path, not an API.

Each name is read from, in order:

1. `globalThis.__API_BASE_URL__` — an explicit runtime override that beats everything below
2. **Static** `process.env.NEXT_PUBLIC_API_URL` / `import.meta.env.VITE_API_URL` reads, written as literal member chains so Next, Vite, Nuxt and SvelteKit can inline them at build time
3. `globalThis.process.env` at runtime (Node, Bun, SSR)
4. `import.meta.env` at runtime (Vite dev and SSR)
5. `globalThis.__VITE_ENV__`, `globalThis.__ENV__`, `globalThis.ENV` — for hand-injected runtime config

If none is set, `baseUrl` is the page origin in a browser or worker. On the server (Node, SSR, tests) there is no page, so a request to a relative path fails with a message naming the option and these variables — rather than guessing a host. A relative `baseUrl` such as `"/api"` is resolved against the page, and `baseUrl: ""` means the page origin itself (it also switches env detection off). A `baseUrl` written without its scheme, such as `"localhost:4000"`, fails with a message asking for `http://` or `https://`.

> Detection must use *literal* `process.env.FOO` reads, because bundlers inline env vars by replacing that exact text. A dynamic `process.env[key]` lookup is invisible to that pass, and browser bundles have no `process` at all — which is why auto-detection silently produced `""` in the browser before v1.0.2.

> The lookup is written so CJS builds never touch `import.meta` (a syntax error there): the CJS output compiles it to an empty object, and every read is individually guarded.

### Worker mode

Requests run in a Blob worker, whose source no bundler ever processed and which has neither `process` nor `import.meta.env`. The base URL is therefore resolved **on the main thread** and forwarded to the worker at init. Auto-detection works identically in both modes.

### When auto-detection can't see your variable

Only build-time-inlined or runtime-present variables are visible. If you use a custom variable name, or load config at runtime, set it explicitly:

```ts
createClient({ baseUrl: window.__RUNTIME_CONFIG__.apiUrl });
```

or set the override before creating the client:

```ts
globalThis.__API_BASE_URL__ = "https://api.example.com";
```

Being explicit is always clearer:

```ts
createClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL });
```

---

## `cancel`

Opt in to cancellation — off by default, so nothing is tracked until you ask.

```ts
createClient({ cancel: true });                  // GETs become cancelable
createClient({ cancel: { methods: "all" } });    // every method
createClient({ cancel: { takeLatest: true } });  // and auto-supersede
```

| Sub-option | Type | Default | Purpose |
|---|---|---|---|
| `methods` | `HttpMethod[] \| "all"` | `["GET"]` | Which methods are tracked automatically |
| `throwOnCancel` | `boolean` | `false` | Reject instead of resolving when canceled. Independent of `throwError` |
| `takeLatest` | `boolean` | `false` | Supersede the previous request with the same identity |

Only `GET` is covered by default: cancelling a read is always safe, whereas a canceled write may already have been committed by the server. Per-request `cancelable` overrides this in both directions.

Full guide: **[[Cancellation]]**.

---

## Options that disable worker mode

Two options cannot be structured-cloned into a worker **when passed as functions**, and supplying a function silently drops the client to the main thread:

```ts
createClient({ extractTokens: (b) => … });        // function → inline mode
createClient({ buildRefreshBody: (r) => … });     // function → inline mode
```

Both have **declarative forms** that are plain data and keep worker isolation:

```ts
createClient({
  extractTokens: { accessKeys: ["jwt"], refreshKeys: ["renew"], roots: ["result"] },
  buildRefreshBody: { field: "refresh_token" },
});
```

A custom storage adapter object is served from the host over the storage bridge and does **not** disable worker mode.

Always verify:

```ts
console.log(api.isWorker);
```

Other function options (`getCsrfToken`, `beforeFunc`, `onError`, …) are handled on the host and keep worker mode intact.

---

## Notable defaults, explained

### `throwError: true`

Throwing is what TanStack Query, SWR and Vue Query expect. With `false`, a 500 arrives as a *successful* result and gets cached as data. The envelope style remains one flag away, globally or per request.

### `storage: "memory"`

Nothing survives a reload, and nothing is readable by page scripts. That's the point. See [[Security Model]] for how to keep sessions across reloads without weakening this.

### `worker: true`

Free security when the environment supports it, and an automatic no-op when it doesn't.

### `refreshSkewMs: 30000`

Wide enough to absorb clock skew and a slow request; narrow enough not to refresh constantly. Widen it if your requests routinely take longer than 30 s, or use per-request `uploadSkewMs`.

### `timeout: 30000`

Per attempt, not per call. Set `0` on uploads and long-poll endpoints.

---

## Recipes

### Development

```ts
createClient({
  baseUrl: "http://localhost:8000/api",
  timeout: 0,
  storage: "local",           // survive hot reloads
  onLog: (e) => console.log(e),
  onError: (r) => console.error(r),
});
```

### Production SPA

```ts
createClient({
  baseUrl: import.meta.env.VITE_API_URL,
  storage: "memory",
  worker: true,
  multiTab: true,
  refreshSkewMs: 60_000,
  onAuthFailure: () => { location.href = "/login"; },
  onError: (r) => { if (r.statusCode >= 500) Sentry.captureMessage(r.message); },
});
```

### Server-side (Node, SSR, route handlers)

```ts
createClient({
  baseUrl: process.env.API_URL,
  worker: false,     // no Worker on the server
  multiTab: false,   // no other tabs; keeps the event loop clean
  storage: "memory",
  timeout: 10_000,
});
```

### Django REST Framework + SimpleJWT

```ts
createClient({
  baseUrl: "https://api.example.com/api/v1",
  loginUrl: "/auth/token/",
  refreshUrl: "/auth/token/refresh/",
  logoutUrl: "/auth/token/blacklist/",
  buildRefreshBody: (refresh) => ({ refresh }),
  extractTokens: (b: any) => ({ accessToken: b?.access, refreshToken: b?.refresh }),
  worker: false, // custom functions disable the worker
});
```

### Laravel Sanctum

```ts
createClient({
  baseUrl: "https://api.example.com",
  authMode: "cookie",
  xsrfCookieName: "XSRF-TOKEN",
  xsrfHeaderName: "X-XSRF-TOKEN",
  loginUrl: "/login",
  logoutUrl: "/logout",
});
```

### Multiple APIs in one app

When the APIs share one login, use the [`services` plugin](Plugins): one client, one session, `api.service("files").get(...)`. When they need separate logins, create separate clients:

```ts
export const mainApi = createClient({
  baseUrl: "https://api.example.com",
  storageKey: "main",
});

export const analyticsApi = createClient({
  baseUrl: "https://analytics.example.com",
  storageKey: "analytics",
  worker: false,   // no auth needed; skip the worker cost
  multiTab: false,
});
```

Distinct `storageKey`s keep their tokens and tab channels independent.

To send one client's token to a second origin you own, list it instead:

```ts
export const api = createClient({
  baseUrl: "https://api.example.com",
  authOrigins: ["https://files.example.com"],
});
```

Next: **[[API Reference]]**
