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
| `baseUrl` | `string` | auto-detected | Prefix for relative URLs. Trailing slashes are normalized |
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
| `getCsrfToken` | `() => string \| undefined` | – | Supply the token directly. Takes precedence |
| **Execution** ||||
| `worker` | `boolean` | `true` | Run requests in a Web Worker |
| `multiTab` | `boolean` | `true` | Sync auth across tabs via BroadcastChannel |
| **Logging** ||||
| `onLog` | `(entry: LogEntry) => void` | `console.info` | Receives entries when a request sets `log: true` |

---

## `baseUrl` auto-detection

When omitted, the first environment variable that is set wins, in this order:

1. `NEXT_PUBLIC_API_URL`
2. `NEXT_PUBLIC_BASE_URL`
3. `VITE_API_URL`
4. `VITE_BASE_URL`
5. `NUXT_PUBLIC_API_URL`
6. `PUBLIC_API_URL`
7. `API_URL`

Read from `process.env` where it exists, and from `globalThis.__VITE_ENV__` where a bundler has injected it. If none is set, `baseUrl` is `""` and relative URLs resolve against the current origin.

> The lookup is written so CJS builds never touch `import.meta` (a syntax error there) and bundlers that statically replace `import.meta.env` still work.

Being explicit is always clearer:

```ts
createClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL });
```

---

## Options that disable worker mode

Three options cannot be structured-cloned into a worker, so supplying any of them silently drops the client to the main thread:

```ts
createClient({ storage: { get, set, clear } }); // a custom adapter object
createClient({ extractTokens: (b) => … });
createClient({ buildRefreshBody: (r) => … });
```

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

Next: **[[API Reference]]**
