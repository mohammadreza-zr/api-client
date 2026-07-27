# Core Concepts

Five ideas explain almost everything the client does.

---

## 1. One engine, three execution modes

There is exactly one implementation of the request pipeline — `executeRequest` — and it is compiled into every mode. The mode only decides *where* that code runs.

```
                     ┌─────────────────────────────┐
createClient()  ───▶ │ Can I use a Worker?         │
                     └──────────┬──────────────────┘
                          yes   │   no
                    ┌───────────┴──────────┐
                    ▼                      ▼
             WorkerHost               CoreClient
        (proxies via postMessage)   (runs inline)
                    │                      │
                    └──────────┬───────────┘
                               ▼
                       executeRequest()
              proactive refresh → fetch → 401 retry
                    → parse → transform
```

| Mode | When | Tokens live in |
|---|---|---|
| **Worker** | Browser, `Worker`/`Blob`/`createObjectURL` available, no custom `storage` object / `extractTokens` / `buildRefreshBody`, CSP permits blob workers | The worker's closure — unreachable from page scripts |
| **Main thread** | Worker unavailable or opted out | A closure on the main thread |
| **Server** | `typeof window === "undefined"` | A closure in the request scope |

Check which one you got:

```ts
api.isWorker; // boolean
```

Because both paths run the same engine, a behaviour verified on the main thread is verified in the worker too. The repo's `verify/worker.mjs` suite asserts this explicitly.

---

## 2. Every call resolves with the same envelope

```ts
interface IRes<R> {
  statusCode: number;                 // 0 when the request never reached the network
  status: boolean;                    // true for 2xx
  message: string;                    // server message, or a readable failure reason
  data?: R;                           // unwrapped from { data: ... } automatically
  loading: boolean;                   // always false on a settled response
  errors?: Record<string, string[]>;  // field-level validation errors
  error?: unknown;                    // the underlying thrown error, if any
  headers?: Record<string, string>;   // lowercased keys
}
```

Success **always** resolves with this shape. Failure either rejects with an [`ApiError`](Responses-and-Errors) wrapping the same envelope (the default) or resolves with it (`throwError: false`).

`statusCode: 0` is the client's "never reached the server" marker: DNS failure, offline, aborted, bad URL. `408` means the request timed out.

### Automatic `data` unwrapping

Most REST APIs wrap payloads:

```json
{ "message": "ok", "data": { "id": 1 } }
```

The client lifts `data` out for you, so `res.data` is `{ id: 1 }`, not the wrapper. Pass `fullData: true` to get the raw body instead.

---

## 3. Refresh is coalesced, not queued

The naive approach is a polling loop (`while (isRefreshing) await sleep(250)`). This client uses a **single shared promise**:

```
Request A ─ 401 ─┐
Request B ─ 401 ─┼─→ ONE refresh call ─→ all three retried with the new token
Request C ─ 401 ─┘
```

`AuthStore.coalesceRefresh` stores the in-flight promise; every concurrent caller awaits the same one. Fifty simultaneous 401s produce exactly one refresh request, with no polling delay.

On top of that, the client refreshes **proactively**: before sending, if the access token expires within `refreshSkewMs` (default 30s), it refreshes first and saves the wasted 401 round trip.

See **[[Token Refresh]]**.

---

## 4. Tokens are values the client owns, not values you pass around

You never attach an `Authorization` header yourself. You never read a token out of storage. The flow is:

```
login() / setTokens()  →  AuthStore  →  engine attaches Authorization
                              │
                              ├─→ persists to the storage adapter
                              ├─→ derives expiry from the JWT `exp` claim
                              ├─→ emits AuthState (no tokens) to subscribers
                              └─→ broadcasts to other tabs (no tokens)
```

What crosses a boundary — a worker `postMessage`, a `BroadcastChannel`, an `onAuthStateChange` callback — is always `AuthState`:

```ts
interface AuthState {
  isAuthenticated: boolean;
  expiresAt: number | null;
  user?: unknown;
}
```

Never a token. That invariant is what makes worker isolation meaningful.

---

## 5. Configuration cascades, and the narrowest scope wins

```
built-in default  →  ClientOptions  →  RequestConfig
     (weakest)                            (strongest)
```

```ts
const api = createClient({
  timeout: 10_000,
  throwError: false,
  headers: { "X-App": "web" },
});

await api.get("/slow", {
  timeout: 60_000,               // wins
  throwError: true,              // wins
  headers: { "X-Trace": "abc" }, // merged with X-App
});
```

Headers merge (per-request keys override client keys, case-insensitively for `Content-Type`). Scalars replace.

---

## The request lifecycle, end to end

```
1.  buildUrl()            addToUrl → addTemplateToUrl → baseUrl join → params
2.  beforeFunc(body)      your outgoing transform
3.  preflight refresh     if token expires within refreshSkewMs / uploadSkewMs
4.  build headers         defaults + per-request + Authorization + CSRF
5.  serialize body        JSON.stringify, unless the body is raw (FormData/Blob/…)
6.  fetch()               with a linked timeout + user AbortSignal
7.  on 401 (+auth wanted) refresh once → retry once  (streams can't replay)
8.  parse                 JSON, or text, or JSON-without-the-header, or undefined
9.  unwrap                lift `data` unless fullData
10. beforeSelectOptions() then afterFunc() — your incoming transforms
11. log                   if `log: true`
12. throw or resolve      ApiError vs. envelope
```

Each numbered step maps to an option documented in **[[Request Config]]**.

---

## Design decisions worth knowing

**Throwing is the default.** TanStack Query, SWR and Vue Query all detect failure through a rejected promise. With a never-throwing client, a 500 is delivered as a *successful* result and cached as data. That is a footgun, so `throwError` defaults to `true`. The envelope style is one flag away.

**`addToUrl` throws on falsy segments.** `api.get("/users", { addToUrl: [undefined] })` is a bug — usually an unresolved ID. Rather than silently request `/users//`, the client throws with the offending index.

**Opaque tokens are trusted.** `isTokenExpired` returns `false` for a token with no readable `exp` claim. The client cannot know when an opaque token dies, so it lets the server decide via a 401 instead of guessing.

**Bad listeners can't break auth.** Every subscriber callback is invoked inside a `try/catch`. One throwing listener never prevents the others from running or corrupts auth state.

Next: **[[Requests]]**
