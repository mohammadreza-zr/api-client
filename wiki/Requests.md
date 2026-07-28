# Requests

## Methods

```ts
api.get<R>(url, config?)
api.post<R>(url, body?, config?)
api.put<R>(url, body?, config?)
api.patch<R>(url, body?, config?)
api.delete<R>(url, config?)
```

All five resolve with `Promise<IRes<R>>`. `R` is the type of `res.data` after unwrapping and after your `afterFunc` — annotate it and everything downstream is typed.

```ts
const { data } = await api.get<User[]>("/users");
//      ^? User[] | undefined
```

> `data` is optional because a 204, an empty body, or a non-JSON response legitimately produces no payload.

`GET` and `DELETE` take no body argument. If you need a body on `DELETE`, most servers accept the identifier in the URL or query string instead:

```ts
await api.delete("/items", { params: { ids: [1, 2, 3] } });
```

---

## Building URLs

Four inputs combine, in this order:

```
addToUrl  →  addTemplateToUrl  →  baseUrl join  →  params
```

### `addTemplateToUrl` — placeholder substitution

```ts
await api.get("/users/{id}/posts/{postId}", {
  addTemplateToUrl: { id: 42, postId: 7 },
});
// → /users/42/posts/7
```

Every occurrence of `{key}` is replaced. This is the clearest way to build resource URLs and it keeps the route readable in logs.

### `addToUrl` — appended path segments

```ts
await api.get("/users", { addToUrl: [42, "posts"] });
// → /users/42/posts/
```

Note the **trailing slash** — this style targets Django-REST-style APIs. If you don't want it, use `addTemplateToUrl` or plain string interpolation.

> **Falsy segments throw.** `addToUrl: [userId]` with `userId === undefined` raises
> `addToUrl contains a falsy segment at index 0: [null]`.
> `0` is explicitly allowed, since it is a valid ID.

### `baseUrl` — joined without slash accidents

```ts
createClient({ baseUrl: "https://api.example.com/v1/" });
await api.get("/users");   // → https://api.example.com/v1/users
await api.get("users");    // → https://api.example.com/v1/users
```

Trailing slashes on the base and leading slashes on the path are normalized, never doubled or dropped.

An **absolute URL always wins** and bypasses the base entirely:

```ts
await api.get("https://cdn.example.com/manifest.json");
```

Override the base for a single call:

```ts
await api.get("/status", { baseUrl: "https://other.example.com" });
```

### `params` — the query string

```ts
await api.get("/users", { params: { page: 2, q: "ada" } });
// → /users?page=2&q=ada
```

If the URL already has a query string, params are appended with `&`.

---

## Query-string serialization

The serializer is a dependency-free port of the `qs` bracket style.

### Nested objects → brackets

```ts
{ name: "x", wallet: { balance: 0, tokens: ["BTC", "USDT"] } }
// → name=x&wallet[balance]=0&wallet[tokens]=BTC&wallet[tokens]=USDT
//   (brackets are percent-encoded on the wire)
```

### Arrays → repeated keys

```ts
{ tags: ["a", "b", "c"] }
// → tags=a&tags=b&tags=c
```

### Arrays of objects → indexed by parent path

```ts
{ filters: [{ field: "age", op: "gt" }] }
// → filters[field]=age&filters[op]=gt
```

### Dates → ISO 8601

```ts
{ since: new Date("2024-01-01") }
// → since=2024-01-01T00%3A00%3A00.000Z
```

### Empty values are dropped, at every depth

`null`, `undefined` and `""` are omitted entirely — including inside nested objects and arrays.

```ts
{ page: 1, q: "", filter: { active: true, role: null } }
// → page=1&filter[active]=true
```

This is deliberate: an empty search box should not send `q=`, which many backends treat as "match the empty string".

> `0` and `false` are **kept** — they are meaningful values, not empty ones.

### Using the serializer standalone

```ts
import { buildQueryString } from "@mrzr/api-client";

buildQueryString({ a: 1, b: { c: [1, 2] } });
// "a=1&b%5Bc%5D=1&b%5Bc%5D=2"
```

### The `ordering` helper

`Params<T>` includes a typed `ordering` field for list endpoints:

```ts
await api.get<ListResponse<User>>("/users", {
  params: { ordering: { createdAt: "desc" } },
});
// → /users?ordering[createdAt]=desc
```

---

## Sending bodies

By default, a body is `JSON.stringify`ed and sent as `application/json`.

```ts
await api.post("/users", { name: "Ada", role: "admin" });
```

These types are detected and passed to `fetch` **untouched**, never stringified:

`FormData` · `File` / `Blob` · `ArrayBuffer` · typed arrays (`Uint8Array`, `DataView`, …) · `URLSearchParams` · `ReadableStream` · `string`

See **[[Uploads and Binary Bodies]]** for content-type handling and the long-upload story.

Force raw passthrough for anything else:

```ts
await api.post("/raw", myThing, { stringifyBody: false });
```

---

## Timeouts

Default: **30 000 ms**, per attempt.

```ts
createClient({ timeout: 10_000 });          // client-wide
await api.get("/slow", { timeout: 60_000 }); // this call
await api.post("/upload", form, { timeout: 0 }); // no timeout
```

A timeout produces `statusCode: 408` with message `"Request timed out"` (or an `ApiError` with the same).

> The budget is **per attempt**. A request that 401s, refreshes and retries gets a fresh timeout for the retry.

---

## Cancellation

Two ways, and they compose.

**Your own `AbortSignal`** — combined with the internal timeout signal (via `AbortSignal.any` where available, with a manual fallback otherwise):

```ts
const controller = new AbortController();
const promise = api.get("/search", { params: { q }, signal: controller.signal });

controller.abort(); // → statusCode 0, canceled: true, "Request aborted"
```

**The built-in registry** — opt in once, then cancel by URL pattern, scope or key, with no controller to carry around:

```ts
const api = createClient({ baseUrl, cancel: true });

api.cancel();                     // everything in flight
api.cancel("/api/v1/products");   // the product screen's requests
api.cancel("search");             // by cancelKey or cancelGroup
```

```ts
// modals and widgets
const scope = api.cancelScope("product-modal");
await scope.get("/api/v1/products/12");
scope.cancel();

// stale searches
await api.get("/search", { params: { q }, cancelKey: "search", takeLatest: true });
```

Both paths set `canceled: true` on the envelope (and on `ApiError`), and neither fires `onError` — navigating away is not a failure the user should see. A timeout stays distinct at `408`.

In worker mode, cancelling posts an `abort` message to the worker, which aborts the real `fetch` — cancellation is not merely cosmetic.

React Query's `queryFn` receives a `signal`; wire it straight through:

```ts
queryFn: ({ signal }) => api.get<User[]>("/users", { signal }),
```

Full guide: **[[Cancellation]]**.

---

## Native `fetch` options

These `RequestInit` fields are forwarded verbatim:

`cache` · `integrity` · `keepalive` · `mode` · `redirect` · `referrer` · `referrerPolicy` · `window`

```ts
await api.get("/data", { cache: "no-store", mode: "cors" });
```

The list is an explicit whitelist, so app-level options never leak into `fetch` and future spec additions can't silently collide.

> `credentials` is **not** per-request — it is derived from `authMode` and settable client-wide, so auth behaviour stays consistent. `body`, `method`, `headers` and `signal` are managed by the client (`signal` is merged, not replaced).

---

## Transform hooks

```ts
await api.post<User>("/users", input, {
  beforeFunc: (body) => ({ ...body, tenant: currentTenant }),  // outgoing
  afterFunc: (data) => camelCaseKeys(data),                    // incoming
  beforeSelectOptions: (data) => data.map(toOption),           // incoming, runs first
});
```

- `beforeFunc` runs before serialization, so it can return a `FormData` or a `Blob`.
- `beforeSelectOptions` then `afterFunc` run after parsing and unwrapping.
- Both incoming hooks run **only on success**.
- In worker mode these functions cannot be structured-cloned, so they are applied on the main thread — `beforeFunc` before the body is posted in, the others after the result comes back. The observable behaviour is identical.

---

## Response headers

```ts
const { headers } = await api.get("/users");
headers?.["x-total-count"];   // keys are always lowercased
headers?.["content-type"];
```

---

## Skipping auth

```ts
await api.get("/public/health", { skipAuth: true });
```

No `Authorization` header, and no proactive refresh. Use it for public endpoints and for auth endpoints you call yourself.

Next: **[[Request Config]]**
