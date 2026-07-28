# Request Config

Every option accepted as the last argument of a request method. All are optional, and all override their client-wide equivalent.

```ts
await api.get<User>("/users/{id}", { /* RequestConfig<User> */ });
```

---

## Full table

| Option | Type | Default | Purpose |
|---|---|---|---|
| **URL** ||||
| `baseUrl` | `string` | client `baseUrl` | Override the base for this call |
| `addToUrl` | `(string \| number)[]` | – | Append path segments, with a trailing slash |
| `addTemplateToUrl` | `Record<string, string \| number>` | – | Replace `{key}` placeholders |
| `params` | `Params<T>` | – | Query string; nested objects and arrays supported |
| **Headers & body** ||||
| `headers` | `Record<string, string>` | – | Merged over the client headers |
| `stringifyBody` | `boolean` | `true` | `false` passes the body to `fetch` untouched |
| `isFormData` | `boolean` | auto | Force multipart handling (drops `Content-Type`) |
| `duplex` | `"half"` | `"half"` | Set automatically for `ReadableStream` bodies |
| **Timing** ||||
| `timeout` | `number` | `30000` | Per-attempt timeout in ms; `0` disables |
| `signal` | `AbortSignal` | – | Your cancellation signal, merged with the timeout |
| **Cancellation** ||||
| `cancelable` | `boolean` | client setting | Track this request so `cancel()` can stop it |
| `cancelKey` | `string` | – | A stable identity: cancel by name, and the unit `takeLatest` compares |
| `cancelGroup` | `string \| string[]` | – | Tags for bulk cancellation |
| `takeLatest` | `boolean` | `false` | Supersede the previous request with the same identity |
| `throwOnCancel` | `boolean` | follows `throwError` | Reject or resolve when canceled |
| **Auth** ||||
| `skipAuth` | `boolean` | `false` | Send without `Authorization`, skip proactive refresh |
| `refreshTokenCheck` | `boolean` | `true` | `false` disables the 401 → refresh → retry flow |
| `uploadSkewMs` | `number` | – | Refresh before sending if the token dies within this window |
| **Response shaping** ||||
| `fullData` | `boolean` | `false` | Return the raw body instead of unwrapping `{ data }` |
| `beforeSelectOptions` | `(data: T) => unknown` | – | Transform the payload; runs before `afterFunc` |
| `afterFunc` | `(data: T) => unknown` | – | Transform the payload |
| `beforeFunc` | `(body: unknown) => unknown` | – | Transform the outgoing body |
| **Errors & logging** ||||
| `throwError` | `boolean` | client setting | Reject with `ApiError`, or resolve with the envelope |
| `hideErrorMessage` | `boolean` | `false` | Suppress the client's `onError` callback |
| `log` | `boolean` | `false` | Emit a structured log entry |
| **Native `fetch`** ||||
| `cache` | `RequestCache` | – | Forwarded to `fetch` |
| `integrity` | `string` | – | Forwarded to `fetch` |
| `keepalive` | `boolean` | – | Forwarded to `fetch` |
| `mode` | `RequestMode` | – | Forwarded to `fetch` |
| `redirect` | `RequestRedirect` | – | Forwarded to `fetch` |
| `referrer` | `string` | – | Forwarded to `fetch` |
| `referrerPolicy` | `ReferrerPolicy` | – | Forwarded to `fetch` |

---

## Everything at once

```ts
await api.get<User>("/users/{id}", {
  addTemplateToUrl: { id: 42 },        // /users/42
  addToUrl: ["posts", 7],              // /users/42/posts/7/
  params: { page: 1, filter: { active: true }, tags: ["a", "b"] },
  headers: { "X-Trace": "abc" },
  timeout: 5_000,
  baseUrl: "https://other.example.com",
  skipAuth: true,
  refreshTokenCheck: false,
  fullData: true,
  hideErrorMessage: true,
  throwError: false,
  uploadSkewMs: 600_000,
  duplex: "half",
  log: true,
  signal: controller.signal,
  cancelable: true,
  cancelKey: "product-detail",
  cancelGroup: "product-modal",
  takeLatest: true,
  cache: "no-store",
  beforeFunc: (body) => body,
  afterFunc: (data) => data,
});
```

---

## Option notes

### `fullData`

Most APIs wrap payloads in `{ message, data }`. The client lifts `data` out automatically. `fullData: true` gives you the untouched body.

```ts
// server: { "message": "ok", "data": { "id": 1 }, "meta": { "total": 99 } }

const a = await api.get("/users/1");
a.data; // { id: 1 }

const b = await api.get("/users/1", { fullData: true });
b.data; // { message: "ok", data: { id: 1 }, meta: { total: 99 } }
```

Reach for it when you need sibling fields like `meta` or `links`.

> `login()` uses `fullData: true` internally so it can find tokens anywhere in the response, then re-applies your unwrapping preference to the value it returns.

### `refreshTokenCheck: false`

Disables both halves of the refresh machinery for this call: no proactive refresh, and a 401 is returned as-is instead of triggering refresh-and-retry.

Use it for your own auth endpoints, so a failing refresh can't recurse.

```ts
await api.post("/auth/verify-otp", { code }, { refreshTokenCheck: false });
```

> A per-request `uploadSkewMs` still forces a refresh even when the client-wide skew is `0`, because it expresses "this specific request needs a fresh token".

### `hideErrorMessage`

Only suppresses the client's `onError` callback. It does **not** stop `throwError` from rejecting, and it does not change the envelope. Use it when a failure is expected and shouldn't produce a toast.

```ts
const res = await api.get("/feature-flags", {
  hideErrorMessage: true,
  throwError: false,
});
const flags = res.status ? res.data : defaults;
```

### `throwError`

Per-request always beats client-wide, in both directions:

```ts
const api = createClient({ throwError: false });   // envelope by default
await api.get("/a");                        // resolves with the envelope
await api.get("/b", { throwError: true });  // rejects with ApiError

const strict = createClient();              // throws by default
await strict.get("/c");                     // rejects
await strict.get("/d", { throwError: false }); // resolves with the envelope
```

### `log`

```ts
await api.get("/users", { log: true });
```

Emits a `LogEntry` to the client's `onLog` handler, or `console.info("[api-client]", entry)` if none is set. Logged for both success and failure. See **[[Logging and Observability]]**.

### `signal`

Combined with the internal timeout signal and the client's cancel registry — whichever fires first wins. Aborting yields `statusCode: 0` with `canceled: true` and message `"Request aborted"`; a timeout yields `408`, `"Request timed out"` and leaves `canceled` unset, so you can tell them apart.

### `cancelable`, `cancelKey`, `cancelGroup`, `takeLatest`

These drive `api.cancel()`. Cancellation is off until the client enables it, and even then covers only `GET` — but any single request can opt in or out:

```ts
await api.post("/draft", body, { cancelable: true });   // opt a write in
await api.get("/session", { cancelable: false });       // opt a read out
```

`cancelKey` and `takeLatest` both imply `cancelable`. A `cancelGroup` alone only tags the request, so tagging a write never makes it cancelable behind your back.

```ts
// Stale-search: each keystroke retires the last
await api.get("/search", { params: { q }, cancelKey: "search", takeLatest: true });

// Bulk: one call kills them all
await api.get("/a", { cancelGroup: "checkout", cancelable: true });
api.cancel("checkout");
```

See **[[Cancellation]]** for the full picture.

### `throwOnCancel`

Follows `throwError` unless set, so nothing changes for an existing client. Set it to make the two differ — reject on real errors, resolve quietly when the user simply navigated away:

```ts
await api.get("/products", { throwOnCancel: false });
```

### `stringifyBody` and `isFormData`

Both are escape hatches; detection is automatic for all standard body types.

- `stringifyBody: false` → pass the body to `fetch` untouched.
- `isFormData: true` → treat the body as multipart and drop the `Content-Type` header so the runtime can generate the boundary.

Use them for exotic body objects the detector can't recognise (a polyfilled `FormData`, for example).

Next: **[[Responses and Errors]]**
