# Cookbook

Practical patterns, copy-paste ready.

---

## Retry with exponential backoff

The client retries a 401 exactly once. Everything else is your policy:

```ts
import { ApiError } from "@mrzr/api-client";

export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseMs = 300 } = {},
): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const retryable =
        e instanceof ApiError &&
        (e.statusCode >= 500 || e.statusCode === 0 || e.statusCode === 408 || e.statusCode === 429);
      if (!retryable || i === attempts - 1) throw e;

      const jitter = Math.random() * 100;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i + jitter));
    }
  }
  throw lastError;
}

const { data } = await withRetry(() => api.get<User[]>("/users"));
```

### Honouring `Retry-After`

```ts
catch (e) {
  if (e instanceof ApiError && e.statusCode === 429) {
    const after = Number(e.response.headers?.["retry-after"] ?? 1);
    await new Promise((r) => setTimeout(r, after * 1000));
    return fn();
  }
  throw e;
}
```

---

## Paginating everything

```ts
import type { ListResponse } from "@mrzr/api-client";

export async function* paginate<T>(path: string, params: Record<string, unknown> = {}) {
  let page = 1;
  while (true) {
    const { data } = await api.get<ListResponse<T>>(path, { params: { ...params, page } });
    if (!data?.results.length) return;
    yield* data.results;
    if (!data.next) return;
    page++;
  }
}

for await (const user of paginate<User>("/users", { active: true })) {
  console.log(user.name);
}
```

Collecting everything with a safety cap:

```ts
export async function collectAll<T>(path: string, max = 10_000): Promise<T[]> {
  const out: T[] = [];
  for await (const item of paginate<T>(path)) {
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}
```

---

## Cancelling a stale search

```ts
let inFlight: AbortController | undefined;

export async function search(q: string) {
  inFlight?.abort();
  inFlight = new AbortController();

  try {
    const { data } = await api.get<Result[]>("/search", {
      params: { q },
      signal: inFlight.signal,
      hideErrorMessage: true,
    });
    return data ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.statusCode === 0) return null; // superseded
    throw e;
  }
}
```

Returning `null` for the aborted case lets the caller ignore stale results without treating them as failures.

---

## Deduplicating identical in-flight requests

```ts
const inFlight = new Map<string, Promise<unknown>>();

export function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

// Ten components mounting at once → one request
const user = await dedupe(`user:${id}`, () =>
  api.get<User>("/users/{id}", { addTemplateToUrl: { id } }),
);
```

---

## Polling until a job finishes

```ts
export async function pollJob(id: string, { intervalMs = 2000, timeoutMs = 300_000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { data } = await api.get<Job>("/jobs/{id}", {
      addTemplateToUrl: { id },
      hideErrorMessage: true,
    });

    if (data?.status === "done") return data;
    if (data?.status === "failed") throw new Error(data.error ?? "Job failed");

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Job timed out");
}
```

---

## Optimistic updates with rollback

```ts
export async function toggleLike(post: Post, setPost: (p: Post) => void) {
  const previous = post;
  setPost({ ...post, liked: !post.liked, likes: post.likes + (post.liked ? -1 : 1) });

  try {
    const { data } = await api.post<Post>("/posts/{id}/like", null, {
      addTemplateToUrl: { id: post.id },
    });
    if (data) setPost(data);
  } catch (e) {
    setPost(previous);
    throw e;
  }
}
```

---

## Concurrency-limited batch requests

```ts
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  });

  await Promise.all(workers);
  return results;
}

const users = await mapLimit(ids, 5, (id) =>
  api.get<User>("/users/{id}", { addTemplateToUrl: { id } }).then((r) => r.data!),
);
```

Tolerating partial failures:

```ts
const settled = await Promise.allSettled(ids.map((id) => users.byId(id)));
const found = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
```

---

## Snake_case ↔ camelCase conversion

```ts
const toCamel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function mapKeys(value: unknown, fn: (k: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => mapKeys(v, fn));
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [fn(k), mapKeys(v, fn)]),
    );
  }
  return value;
}

await api.post("/users", input, {
  beforeFunc: (body) => mapKeys(body, toSnake),
  afterFunc: (data) => mapKeys(data, toCamel),
});
```

Applying it everywhere via a wrapper:

```ts
export function caseConverting(api: ApiClient): ApiClient {
  const hooks = {
    beforeFunc: (b: unknown) => mapKeys(b, toSnake),
    afterFunc: (d: unknown) => mapKeys(d, toCamel),
  };
  return {
    ...api,
    get: (u, c) => api.get(u, { ...hooks, ...c }),
    post: (u, b, c) => api.post(u, b, { ...hooks, ...c }),
    put: (u, b, c) => api.put(u, b, { ...hooks, ...c }),
    patch: (u, b, c) => api.patch(u, b, { ...hooks, ...c }),
    delete: (u, c) => api.delete(u, { ...hooks, ...c }),
  } as ApiClient;
}
```

---

## Runtime response validation with Zod

```ts
import { z } from "zod";

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
});

export async function getUser(id: number) {
  const { data } = await api.get("/users/{id}", { addTemplateToUrl: { id } });
  return UserSchema.parse(data); // throws ZodError on a schema mismatch
}
```

Or inside `afterFunc`, so validation is part of the request:

```ts
await api.get("/users", {
  afterFunc: (data) => z.array(UserSchema).parse(data),
});
```

---

## Offline queue

```ts
type Queued = { method: "post" | "put" | "patch" | "delete"; url: string; body?: unknown };

const queue: Queued[] = JSON.parse(localStorage.getItem("queue") ?? "[]");
const save = () => localStorage.setItem("queue", JSON.stringify(queue));

export async function send(item: Queued) {
  if (!navigator.onLine) { queue.push(item); save(); return; }
  try {
    await (api as any)[item.method](item.url, item.body);
  } catch (e) {
    if (e instanceof ApiError && e.statusCode === 0) { queue.push(item); save(); return; }
    throw e;
  }
}

window.addEventListener("online", async () => {
  while (queue.length) {
    const item = queue[0];
    try { await (api as any)[item.method](item.url, item.body); queue.shift(); save(); }
    catch { break; }
  }
});
```

---

## Rate limiting yourself

```ts
function throttle(perSecond: number) {
  const gap = 1000 / perSecond;
  let next = 0;
  return async () => {
    const wait = Math.max(0, next - Date.now());
    next = Date.now() + wait + gap;
    if (wait) await new Promise((r) => setTimeout(r, wait));
  };
}

const slot = throttle(10); // 10 requests/second

for (const id of ids) {
  await slot();
  await api.get(`/users/${id}`);
}
```

---

## Mocking in tests

The client only needs `fetch`, so mock at that level:

```ts
import { createClient } from "@mrzr/api-client";

function mockFetch(routes: Record<string, unknown>) {
  globalThis.fetch = (async (input: RequestInfo) => {
    const url = new URL(String(input));
    const body = routes[url.pathname];
    return new Response(JSON.stringify(body ?? { message: "Not found" }), {
      status: body ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test("lists users", async () => {
  mockFetch({ "/users": { data: [{ id: 1, name: "Ada" }] } });

  const api = createClient({ baseUrl: "http://test", worker: false, multiTab: false });
  const { data } = await api.get<User[]>("/users");

  expect(data).toEqual([{ id: 1, name: "Ada" }]);
  api.destroy();
});
```

Always use `worker: false, multiTab: false` in tests — jsdom's `Worker` and `BroadcastChannel` are unreliable, and an open channel can keep the runner alive.

With MSW:

```ts
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

const server = setupServer(
  http.get("http://test/users", () => HttpResponse.json({ data: [{ id: 1 }] })),
);

beforeAll(() => server.listen());
afterAll(() => server.close());
```

---

## Feature flags with a safe fallback

```ts
const DEFAULTS = { newCheckout: false, betaSearch: false };

export async function loadFlags(): Promise<typeof DEFAULTS> {
  const res = await api.get<typeof DEFAULTS>("/flags", {
    throwError: false,
    hideErrorMessage: true,
    timeout: 2_000,
    skipAuth: true,
  });
  return res.status ? { ...DEFAULTS, ...res.data } : DEFAULTS;
}
```

A flags endpoint should never break the app, so this is a good use of the envelope style.

---

## Health check on boot

```ts
export async function isApiReachable(): Promise<boolean> {
  const res = await api.get("/health", {
    throwError: false,
    hideErrorMessage: true,
    skipAuth: true,
    timeout: 3_000,
  });
  return res.status;
}
```

---

## Downloading a file

```ts
export async function download(path: string, filename: string) {
  const res = await api.get<Blob>(path, {
    headers: { Accept: "application/octet-stream" },
    fullData: true,
    timeout: 0,
  });

  const blob = res.data instanceof Blob ? res.data : new Blob([String(res.data)]);
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}
```

> The client parses responses as JSON or text. For true binary downloads, calling `fetch` directly is simpler — the auth header is the only thing you lose, and you can read it from `getAuthState()`-adjacent app state or use cookie mode.

Next: **[[Migration Guide]]**
