# API Reference

Everything the package exports.

```ts
import {
  createClient,
  ApiError,
  buildQueryString,
  getTokenExpiry,
  isTokenExpired,
  MemoryStorage,
  WebStorage,
  CookieStorage,
} from "@mrzr/api-client";

import type {
  ApiClient, AuthMode, AuthState, ClientOptions, HttpMethod, IRes,
  ListResponse, LogEntry, Ordering, Params, RequestConfig,
  StorageKind, TokenExtractor, TokenPair, TokenStorage,
} from "@mrzr/api-client";
```

---

## `createClient(options?): ApiClient`

Creates a client. Picks worker mode when the environment allows it, otherwise runs the identical implementation inline.

```ts
function createClient(options?: ClientOptions): ApiClient;
```

Create one per API and export it. Every client owns a worker and a BroadcastChannel.

---

## `ApiClient`

### Request methods

```ts
get<R = unknown>(url: string, config?: RequestConfig<R>): Promise<IRes<R>>;
post<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
put<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
patch<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
delete<R = unknown>(url: string, config?: RequestConfig<R>): Promise<IRes<R>>;
```

`R` is the type of `res.data` after unwrapping. Rejects with [`ApiError`](Responses-and-Errors) on failure unless `throwError` is `false`.

```ts
const { data } = await api.get<User[]>("/users", { params: { page: 1 } });
const created  = await api.post<User>("/users", { name: "Ada" });
await api.delete("/users/{id}", { addTemplateToUrl: { id: 42 } });
```

---

### `login(body, config?)`

```ts
login<R = unknown>(body: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
```

`POST`s to `loginUrl` with `skipAuth`, no refresh check, and `fullData` internally; extracts tokens and `user`; broadcasts `login` to other tabs; then re-applies your unwrapping preference to the returned `data`.

```ts
await api.login({ email: "a@b.com", password: "secret" });
```

Obeys `throwError` — bad credentials reject with an `ApiError`.

---

### `logout(config?)`

```ts
logout<R = unknown>(config?: RequestConfig<R>): Promise<IRes<R>>;
```

`POST`s to `logoutUrl`, then clears tokens locally **regardless of the result** and broadcasts `logout`. **Never throws** — a network failure still signs you out.

```ts
await api.logout();
```

---

### `setTokens(tokens)`

```ts
setTokens(tokens: TokenPair): Promise<void>;
```

Seed tokens from SSR, an OAuth callback, or your own login flow. Only the keys you pass are updated. Expiry is derived from the JWT `exp` claim when `expiresAt` is omitted. Broadcasts `login`.

```ts
await api.setTokens({ accessToken, refreshToken });
await api.setTokens({ accessToken });                 // keeps the existing refresh token
await api.setTokens({ accessToken: undefined });      // local sign-out
```

---

### `refresh()`

```ts
refresh(): Promise<string | null>;
```

Forces a refresh. Returns the new access token (`""` in cookie mode) or `null` on failure. Coalesced with any in-flight refresh, so concurrent calls are safe.

```ts
const token = await api.refresh();
if (token === null) redirectToLogin();
```

---

### `getAuthState()`

```ts
getAuthState(): Promise<AuthState>;
```

Awaits storage hydration, then returns the current state. **Never contains tokens.**

```ts
const { isAuthenticated, expiresAt, user } = await api.getAuthState();
```

---

### `restoreSession(url?)`

```ts
restoreSession(url?: string): Promise<AuthState>;
```

Asks the server whether a session already exists, and records the answer.

Needed for `authMode: "cookie"`: httpOnly cookies are unreadable from JS, so
after a page reload the client cannot tell a signed-in visitor from a signed-out
one until it makes a request.

```ts
// On app startup
const state = await api.restoreSession("/api/auth/me");
```

- With `url`, it calls that endpoint and also populates `state.user` from the
  response.
- Without `url`, it probes the refresh endpoint.
- In **header mode** it makes no request and simply returns the rehydrated
  state, so it is safe to call unconditionally.

---

### `onAuthStateChange(listener)`

```ts
onAuthStateChange(listener: (state: AuthState) => void): () => void;
```

Subscribe to auth changes. Returns an unsubscribe function. Fires on login, logout, refresh, `setTokens`, user updates, and cross-tab events. Listener exceptions are caught.

```ts
useEffect(() => api.onAuthStateChange(setState), []);
```

---

### `isWorker`

```ts
readonly isWorker: boolean;
```

Whether requests actually run in a Web Worker. Useful for asserting your security posture in production.

---

### `destroy()`

```ts
destroy(): void;
```

Terminates the worker, aborts pending requests (their promises reject with `"Client destroyed"`), closes the tab channel, clears listeners and revokes the blob URL.

Call it for short-lived clients — per-request server clients, tests, torn-down micro-frontends.

```ts
const api = createClient({ baseUrl, worker: false });
try {
  return (await api.get("/users")).data;
} finally {
  api.destroy();
}
```

---

## `ApiError`

```ts
class ApiError extends Error {
  readonly name: "ApiError";
  readonly statusCode: number;
  readonly errors?: Record<string, string[]>;
  readonly data?: unknown;
  readonly response: IRes<unknown>;
  constructor(response: IRes<unknown>);
}
```

```ts
try {
  await api.post("/users", input);
} catch (e) {
  if (e instanceof ApiError && e.statusCode === 422) showFieldErrors(e.errors);
  else throw e;
}
```

---

## `buildQueryString(params, prefix?)`

```ts
function buildQueryString(params: Record<string, unknown>, prefix?: string): string;
```

The client's serializer, exported for standalone use. Nested objects become brackets, arrays repeat the key, `Date`s become ISO strings, and `null`/`undefined`/`""` are dropped at every depth.

```ts
buildQueryString({ a: 1, b: { c: [1, 2] } });
// "a=1&b%5Bc%5D=1&b%5Bc%5D=2"

buildQueryString({ page: 1, q: "", tags: ["x", null, "y"] });
// "page=1&tags=x&tags=y"
```

---

## `getTokenExpiry(token?)`

```ts
function getTokenExpiry(token?: string | null): number | null;
```

Reads the JWT `exp` claim as **epoch milliseconds**. Returns `null` for anything that isn't a three-part JWT with a numeric `exp`. Never verifies the signature.

```ts
const exp = getTokenExpiry(token);
if (exp) console.log("expires", new Date(exp).toLocaleString());
```

---

## `isTokenExpired(token, skewMs?)`

```ts
function isTokenExpired(token: string | null | undefined, skewMs?: number): boolean;
```

`true` when the token has a **known** expiry that has already passed (optionally shifted by `skewMs`). Returns `false` when the expiry is unknown — "unknown" is not "expired".

```ts
isTokenExpired(token);          // is it dead now?
isTokenExpired(token, 60_000);  // will it be dead in a minute?
```

---

## Storage classes

```ts
class MemoryStorage implements TokenStorage {
  constructor();
}

class WebStorage implements TokenStorage {
  constructor(key: string, kind: "local" | "session");
}

class CookieStorage implements TokenStorage {
  constructor(key: string, days?: number); // days defaults to 7
}
```

All three implement `get()` / `set(tokens)` / `clear()` and swallow storage errors (Safari private mode, quota, corrupt JSON) rather than throwing. See [[Storage Adapters]].

---

## Quick index

| Export | Kind | Purpose |
|---|---|---|
| `createClient` | function | Create a client |
| `ApiError` | class | Thrown on failure |
| `buildQueryString` | function | Serialize params |
| `getTokenExpiry` | function | Read a JWT `exp` |
| `isTokenExpired` | function | Expiry check with skew |
| `MemoryStorage` | class | In-memory adapter |
| `WebStorage` | class | localStorage/sessionStorage adapter |
| `CookieStorage` | class | Non-httpOnly cookie adapter |
| `ApiClient` | type | The client interface |
| `ClientOptions` | type | `createClient` options |
| `RequestConfig<T>` | type | Per-request options |
| `IRes<R>` | type | The response envelope |
| `AuthState` | type | Auth state (never tokens) |
| `TokenPair` | type | `{ accessToken?, refreshToken?, expiresAt? }` |
| `TokenStorage` | type | Custom adapter interface |
| `TokenExtractor` | type | `(body) => TokenPair \| null` |
| `LogEntry` | type | Structured log record |
| `Params<T>` | type | Query params, with typed `ordering` |
| `ListResponse<T>` | type | `{ count, next, previous, results }` |
| `Ordering<T>` | type | `{ [K in keyof T]?: "asc" \| "desc" }` |
| `HttpMethod` | type | `"GET" \| "POST" \| …` |
| `AuthMode` | type | `"header" \| "cookie"` |
| `StorageKind` | type | `"memory" \| "local" \| "session" \| "cookie"` |

Next: **[[TypeScript Types]]**
