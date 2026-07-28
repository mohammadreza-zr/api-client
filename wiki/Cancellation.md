# Cancellation

Stop in-flight requests when the user changes page, closes a modal, or types the next keystroke.

Cancellation is **opt-in**. Nothing is tracked, and there is no bookkeeping cost, until you ask for it.

```ts
const api = createClient({ baseUrl, cancel: true });

// somewhere in your router
router.on("navigate", () => api.cancel());
```

---

## Why an option and not the default

Tracking every request means holding an `AbortController` and a registry entry for each one, and — more importantly — it means a stray `cancel()` could kill a request the app depended on. Neither belongs in a default.

So the client ships with cancellation **off**, and when you turn it on only `GET` is covered:

| | Tracked by default? | Why |
|---|---|---|
| `GET` | ✅ when `cancel` is enabled | Cancelling a read is always safe — you just don't get the answer |
| `POST` `PUT` `PATCH` `DELETE` | ❌ opt-in per request or via `methods` | The server may already have committed the write, and you'd never learn the outcome |

Widen it when you mean to:

```ts
createClient({ cancel: { methods: "all" } });              // everything
createClient({ cancel: { methods: ["GET", "DELETE"] } });  // pick your own
await api.post("/draft", body, { cancelable: true });      // just this one
```

---

## The three ways to use it

### 1. Cancel by URL pattern — page changes

The common case. No keys to invent, no bookkeeping: name the endpoint.

```ts
const api = createClient({ baseUrl, cancel: true });

// Everything, on route change
api.cancel();

// Just the product screen's requests
api.cancel("/api/v1/products");
```

`"/api/v1/products"` is a **prefix over path segments**, so it covers the whole subtree:

| Pattern | Matches | Does **not** match |
|---|---|---|
| `/api/v1/products` | `/api/v1/products`<br>`/api/v1/products/12`<br>`/api/v1/products/12/reviews` | `/api/v1/products-archive`<br>`/api/v1/orders` |
| `/api/v1/products$` | `/api/v1/products` | `/api/v1/products/12` |
| `/users/:id` or `/users/*` | `/users/7`<br>`/users/7/posts` | `/users`<br>`/orgs/7` |
| `/users/:id$` | `/users/7` | `/users/7/posts` |
| `/api/**/images` | `/api/images`<br>`/api/a/b/images` | `/other/images` |

Segment-aware matching is the point: `products-archive` is a different resource from `products`, and a naive `startsWith` would take it down with the rest.

Query strings are ignored — `/search` matches `/search?q=shoes`. Use a predicate if you need to inspect them.

### 2. Cancel by scope — modals and widgets

A scope is a thin wrapper whose requests are all tagged, so one call stops the lot. No pattern to keep in sync with your routes.

```ts
const scope = api.cancelScope("product-modal");

const { data } = await scope.get("/api/v1/products/12");
await scope.get("/api/v1/products/12/reviews");

// when the modal closes
scope.cancel();
```

Scopes are self-enabling: requests made through one are cancelable **even on a client that never set `cancel`**. Creating the scope is the opt-in.

Writes are still excluded, for the same reason as everywhere else — pass `cancelable: true` when you genuinely want a write abandoned on close.

### 3. Cancel by key — stale searches

`takeLatest` retires the previous request that shares an identity, so a fast typist can't be shown the results of an older keystroke.

```ts
async function search(q: string) {
  const { data } = await api.get("/search", {
    params: { q },
    cancelKey: "search",
    takeLatest: true,
  });
  return data;
}
```

Identity is the `cancelKey`, or `METHOD + path` when you don't give one. Turn it on client-wide with `cancel: { takeLatest: true }`.

### What is never canceled

`login()`, `logout()` and the `restoreSession()` probe are **never** tracked, even with `methods: "all"`. They establish the session, and a blanket `api.cancel()` on the first route change would otherwise abort the handshake and leave the app believing nobody is signed in.

Pass `cancelable: true` explicitly if you genuinely want one of them cancelable.

---

## Every selector

```ts
api.cancel();                                    // everything in flight
api.cancel("/api/v1/products");                  // URL pattern
api.cancel("search");                            // a cancelKey…
api.cancel("checkout");                          // …or a cancelGroup
api.cancel(/\/products\/\d+$/);                  // regex over url and path
api.cancel({ url: "/users/:id", method: "GET" }); // all fields must match
api.cancel((r) => Date.now() - r.startedAt > 10_000); // your own rule
api.cancel("/api/v1/products", "left the page"); // with a reason
```

A bare string is deliberately forgiving — it tries the key, then the group, then the URL pattern — because at the call site you know which you meant. Reach for the object form when you need to be exact.

`cancel()` returns how many requests it stopped, and is always safe to call: with nothing in flight it returns `0`.

---

## Inspecting what's in flight

```ts
api.pending();                     // every tracked request
api.pending("/api/v1/products");   // filtered by the same selectors
```

```ts
interface PendingRequest {
  id: number;          // unique per client
  method: HttpMethod;
  url: string;         // fully resolved, query included
  path: string;        // no origin, no query — what patterns match
  key?: string;        // its cancelKey
  groups: string[];    // its cancelGroup tags
  startedAt: number;   // epoch ms
}
```

---

## What a canceled request looks like

A cancellation **resolves** — even under the default `throwError: true` — with `canceled: true` on the envelope:

```ts
{
  statusCode: 0,
  status: false,
  canceled: true,
  cancelReason: "left the page",   // only when you passed one
  message: "Request canceled: left the page",
  loading: false,
}
```

So the guard is one line, with no `try`/`catch`:

```ts
const res = await api.get("/api/v1/products");
if (res.canceled) return;      // superseded or unmounted — not an error
setProducts(res.data);
```

Three details worth knowing:

- **`onError` never fires for a cancellation.** Navigating away should not raise an error toast.
- **A timeout is not a cancellation.** It stays `408` / `"Request timed out"`, with `canceled` unset, so you can still tell them apart.
- **Your own `AbortSignal` behaves identically.** It sets `canceled: true` and resolves too — one rule, not two.

### Why cancellation doesn't throw

`throwOnCancel` is **independent of `throwError`**, and defaults to `false`. Real failures still throw; only cancellation is exempt. Two measured reasons:

1. **TanStack Query retries a rejected cancel.** A rejection looks like an ordinary retryable error, so Query re-fires the request you just canceled. Measured against real `query-core`: **two** server hits when cancellation throws, **one** when it resolves. (Query's own `signal` path is unaffected either way — it short-circuits before the promise settles — so throwing buys nothing there and actively harms `api.cancel()`.)

2. **It breaks the ordinary React pattern.** An async IIFE in `useEffect` has no `catch`, so cancelling on unmount produces an **unhandled rejection** — a red overlay in Next dev, noise in your error reporter.

Rejecting while `onError` stays silent would also be half a position: either a cancellation is a failure or it isn't.

Opt back in when you want a cancellation to abort a surrounding `try` block:

```ts
createClient({ cancel: { throwOnCancel: true } });   // client-wide
await api.get("/x", { throwOnCancel: true });        // one call
```

```ts
try {
  await api.get("/x", { throwOnCancel: true });
} catch (e) {
  if (e instanceof ApiError && e.canceled) return;
  throw e;
}
```

---

## Framework recipes

Copy-paste ready. Each one is complete — client setup included — and enables the options that make cancellation actually useful.

### The client

```ts
// lib/api.ts
import { createClient } from "@mrzr/api-client";

export const api = createClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL,
  cancel: {
    methods: ["GET"],   // reads only; add "all" if you also cancel writes
    takeLatest: true,   // a newer request retires its older twin
  },
});
```

`takeLatest` is the one people forget and then miss: it kills the stale-search race and quietly dedupes React StrictMode's double-mount in dev.

### React — cancel on unmount

```tsx
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export function UserList() {
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => {
    const scope = api.cancelScope("user-list");   // inside the effect

    (async () => {
      const res = await scope.get<User[]>("/users");
      if (res.canceled) return;                   // unmounted — nothing to do
      setUsers(res.data ?? []);
    })();

    return () => scope.cancel();
  }, []);

  return <ul>{users.map((u) => <li key={u.id}>{u.name}</li>)}</ul>;
}
```

Create the scope **inside** the effect. A module-level scope is shared by every mount, so a remount would cancel the new request along with the old one.

### React — a reusable hook

```tsx
import { useEffect, useRef } from "react";
import { api } from "@/lib/api";
import type { CancelScope } from "@mrzr/api-client";

/** A cancel scope tied to the component's lifetime. */
export function useCancelScope(name: string): CancelScope {
  const ref = useRef<CancelScope>();
  ref.current ??= api.cancelScope(name);

  useEffect(() => {
    const scope = ref.current!;
    return () => scope.cancel();
  }, []);

  return ref.current;
}
```

```tsx
const scope = useCancelScope("dashboard");
const res = await scope.get("/api/v1/stats");
if (res.canceled) return;
```

### React — search box with take-latest

```tsx
const [results, setResults] = useState<Result[]>([]);

useEffect(() => {
  if (!query) return;

  (async () => {
    const res = await api.get<Result[]>("/search", {
      params: { q: query },
      cancelKey: "search",   // identity
      takeLatest: true,      // supersede the previous keystroke
    });
    if (res.canceled) return;   // a newer keystroke won
    setResults(res.data ?? []);
  })();
}, [query]);
```

No debounce required for correctness — the newest request always wins. Debounce still saves requests.

### A modal component

```tsx
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";

export function ProductModal({ id }: { id: string }) {
  const [product, setProduct] = useState<Product>();
  const [reviews, setReviews] = useState<Review[]>([]);
  const scope = useMemo(() => api.cancelScope(`product-${id}`), [id]);

  useEffect(() => () => scope.cancel(), [scope]);

  useEffect(() => {
    (async () => {
      const [p, r] = await Promise.all([
        scope.get<Product>(`/api/v1/products/${id}`),
        scope.get<Review[]>(`/api/v1/products/${id}/reviews`),
      ]);
      if (p.canceled || r.canceled) return;   // modal closed mid-flight
      setProduct(p.data);
      setReviews(r.data ?? []);
    })();
  }, [scope, id]);

  return <Dialog>{/* … */}</Dialog>;
}
```

Everything the modal started dies with it — one `scope.cancel()`, however many requests.

### Next.js App Router — cancel on navigation

```tsx
"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";

export function CancelOnNavigate() {
  const pathname = usePathname();
  useEffect(() => () => { api.cancel(); }, [pathname]);
  return null;
}
```

Drop `<CancelOnNavigate />` in your root layout. Narrow it with a pattern — `api.cancel("/api/v1/products")` — if some requests should survive the transition.

### Next.js Pages Router

```ts
// pages/_app.tsx
useEffect(() => {
  const onStart = () => api.cancel();
  router.events.on("routeChangeStart", onStart);
  return () => router.events.off("routeChangeStart", onStart);
}, [router]);
```

### Vue — cancel on unmount

```vue
<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { api } from "@/lib/api";

const product = ref<Product>();
const scope = api.cancelScope("product-detail");

onUnmounted(() => scope.cancel());

const res = await scope.get<Product>(`/api/v1/products/${props.id}`);
if (!res.canceled) product.value = res.data;
</script>
```

### Vue Router — cancel on leave

```ts
router.beforeEach((to, from, next) => {
  if (to.path !== from.path) api.cancel();
  next();
});
```

### Svelte

```svelte
<script lang="ts">
  import { onDestroy } from "svelte";
  import { api } from "$lib/api";

  const scope = api.cancelScope("dashboard");
  onDestroy(() => scope.cancel());

  let stats: Stats | undefined;
  scope.get<Stats>("/api/v1/stats").then((res) => {
    if (!res.canceled) stats = res.data;
  });
</script>
```

### Angular

```ts
@Component({ /* … */ })
export class ProductComponent implements OnInit, OnDestroy {
  private scope = api.cancelScope("product");
  product?: Product;

  async ngOnInit() {
    const res = await this.scope.get<Product>("/api/v1/products/1");
    if (!res.canceled) this.product = res.data;
  }

  ngOnDestroy() { this.scope.cancel(); }
}
```

## Using cancellation with a data library

**Whoever owns the request lifecycle should own its cancellation.** If your data layer hands you a `signal`, wire it through and let the library drive. `api.cancel()` still works alongside it — it is not forbidden, just rarely the better tool for requests the library already manages.

### TanStack Query — queries

Wire the `signal` through and unwrap the envelope. That is the whole setup:

```ts
useQuery({
  queryKey: ["users"],
  queryFn: ({ signal }) => api.get<User[]>("/users", { signal }).then((r) => r.data),
});
```

React Query then cancels on unmount, on key change, and via `queryClient.cancelQueries()` — all aborting the real socket.

> **Why `.then(r => r.data)`?** Without it you cache the whole `IRes` envelope, so you'd read `data.data.name` instead of `data.name`.

> **Keep `throwError: true` (the default) for react-query.** It needs a rejection to mark a query failed; with `throwError: false` a 500 would be cached as successful data.

### Cancelling a group of queries — the modal case

Use `cancelQueries` with a **key prefix**. No scope needed, and no extra imports:

```ts
// every query under ["product", …]
useQuery({ queryKey: ["product", id],            queryFn: ({ signal }) => api.get(`/api/v1/products/${id}`, { signal }).then(r => r.data) });
useQuery({ queryKey: ["product", id, "reviews"], queryFn: ({ signal }) => api.get(`/api/v1/products/${id}/reviews`, { signal }).then(r => r.data) });

// when the modal closes — one call cancels the whole prefix
queryClient.cancelQueries({ queryKey: ["product"] });
```

```tsx
function ProductModal({ id }: { id: string }) {
  const qc = useQueryClient();
  useEffect(() => () => { qc.cancelQueries({ queryKey: ["product"] }); }, [qc]);
  // …
}
```

Both sockets really abort, nothing partial is cached, and no retry is triggered.

### Why `api.cancel()` isn't the first choice for queries

It works — the socket really closes — but react-query can't see it happen, and two things follow:

```ts
api.cancel();          // react-query is unaware
```

1. **The canceled envelope gets cached as success.** Cancellation resolves (by design), so Query treats it as a normal result and stores `{ statusCode: 0, canceled: true }` as your data.
2. **Query may retry it.** The failure looks retryable, so it re-fires the request you just canceled. Measured: 2 server hits instead of 1.

Throwing from inside `queryFn` does not avoid the retry — verified against `DOMException`, `CancelledError` and a plain `Error`; all three still retried. Only `cancelQueries` stops it.

So if you do reach for `api.cancel()` on a react-query-managed request, pair it with `cancelQueries` — tell Query first, then hard-abort:

```ts
await queryClient.cancelQueries({ queryKey: ["product"] });
scope.cancel();   // belt and braces; usually already a no-op
```

### TanStack Query — mutations

Mutations get **no `signal`** from react-query (the context is `{ client, meta, mutationKey }`), and are **not** canceled on unmount — deliberately, since a mutation is a side effect. So here `api.cancel()` is the only option, and a scope is the clean way:

```tsx
function CreateTodo() {
  const scope = useMemo(() => api.cancelScope("create-todo"), []);
  useEffect(() => () => scope.cancel(), [scope]);

  const mutation = useMutation({
    mutationFn: async (input: NewTodo) => {
      const res = await scope.post<Todo>("/todos", input, { cancelable: true });
      if (res.canceled) throw new DOMException("Canceled", "AbortError");
      return res.data;
    },
    onError: (e) => {
      if (e instanceof ApiError && e.canceled) return;   // don't toast a cancel
      if ((e as Error)?.name === "AbortError") return;
      toast.error((e as Error).message);
    },
  });
}
```

The `if (res.canceled) throw` is what stops `onSuccess` firing with a canceled envelope. Mutations don't retry by default, so there is no retry storm here.

> Cancelling a write means the server may already have committed it — you only stop hearing the answer. Fine for a draft-save; think twice for a payment.

### SWR

SWR has no `signal`, so `api.cancel()` and scopes are the right tool:

```tsx
const scope = useMemo(() => api.cancelScope("dashboard"), []);
useEffect(() => () => scope.cancel(), [scope]);

const { data } = useSWR("/api/v1/stats", (url) =>
  scope.get(url).then((r) => {
    if (r.canceled) throw new DOMException("Canceled", "AbortError");
    return r.data;
  }),
);
```

### No data library

The simplest case — resolve and guard, no `try`/`catch` needed:

```ts
const res = await scope.get("/api/v1/products");
if (res.canceled) return;
render(res.data);
```

---

## Worker mode

Cancellation works identically with `worker: true`, and it is genuine — the real `fetch` stops and the socket closes.

The registry lives on the **main thread**, because `api.cancel()` has to be synchronous and has to work before the worker has even booted. A cancellation is forwarded to the worker as an `abort` message, which aborts the actual request:

```
main thread: api.cancel("/api/v1/products")
      └─ registry match → postMessage({ kind: "abort", id, reason })
worker:      controller.abort(CancelError) → fetch really stops
```

`pending()` is answered from the host too, so it stays synchronous.

---

## Reference

### Client option

```ts
createClient({
  cancel: true,
  // or
  cancel: {
    methods: ["GET"],       // or "all"; default ["GET"]
    throwOnCancel: false,   // default; independent of throwError
    takeLatest: false,      // default
  },
});
```

### Request config

| Option | Type | Purpose |
|---|---|---|
| `cancelable` | `boolean` | Track this request, or explicitly don't. Overrides the client setting |
| `cancelKey` | `string` | A stable identity — cancel by name, and the unit `takeLatest` compares |
| `cancelGroup` | `string \| string[]` | Tags for bulk cancellation |
| `takeLatest` | `boolean` | Supersede the previous request with the same identity |
| `throwOnCancel` | `boolean` | Reject instead of resolving when canceled |

### Client methods

| Method | Returns | Purpose |
|---|---|---|
| `cancel(selector?, reason?)` | `number` | Cancel matching requests; returns how many stopped |
| `pending(selector?)` | `PendingRequest[]` | Inspect what's in flight |
| `cancelScope(name?)` | `CancelScope` | A wrapper whose requests cancel together |

Next: **[[Request Config]]**
