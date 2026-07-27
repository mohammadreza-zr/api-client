# Logging and Observability

## Request logging

Opt in per request:

```ts
await api.get("/users", { log: true });
```

The client emits a structured entry to `onLog`, or to `console.info("[api-client]", entry)` when no handler is configured. Entries are emitted for **both** success and failure.

```ts
interface LogEntry {
  url: string;         // the final URL, after templating and params
  method: HttpMethod;
  statusCode: number;
  status: boolean;
  message: string;
  durationMs: number;  // wall clock, including refresh + retry
  timestamp: string;   // ISO 8601
  error?: unknown;
}
```

```ts
const api = createClient({
  onLog: (e) => {
    console.log(`${e.method} ${e.url} → ${e.statusCode} (${e.durationMs}ms)`);
  },
});
```

> `durationMs` covers the **whole** call, including a proactive refresh and a 401 retry. A slow entry may mean two network round trips, not one slow server.

### Logging everything

`log` is per-request by design, so debug logging doesn't leak into production noise. To log everything, wrap the client:

```ts
function withLogging(api: ApiClient): ApiClient {
  return new Proxy(api, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (!["get", "post", "put", "patch", "delete"].includes(prop as string)) {
        return value.bind(target);
      }
      return (...args: unknown[]) => {
        const last = args[args.length - 1];
        const config = { ...(typeof last === "object" && last ? last : {}), log: true };
        const rest = typeof last === "object" && last ? args.slice(0, -1) : args;
        return (value as Function).apply(target, [...rest, config]);
      };
    },
  });
}

export const api = withLogging(createClient({ baseUrl }));
```

---

## Error monitoring

`onError` fires for **every** failed request — regardless of `throwError` — unless the request set `hideErrorMessage: true`.

```ts
const api = createClient({
  onError: (res) => {
    if (res.statusCode === 0) return; // offline; not actionable
    if (res.statusCode === 401) return; // handled by the refresh flow

    Sentry.captureMessage(res.message, {
      level: res.statusCode >= 500 ? "error" : "warning",
      extra: { statusCode: res.statusCode, errors: res.errors },
    });
  },
});
```

`onError` is for cross-cutting concerns. Per-call handling still belongs in your `catch` block or `status` check.

---

## Auth observability

```ts
const api = createClient({
  onAuthStateChanged: (s) => {
    analytics.setUser(s.isAuthenticated ? (s.user as User)?.id : null);
  },
  onAuthFailure: () => {
    analytics.track("session_expired");
  },
});
```

Or subscribe after the fact:

```ts
api.onAuthStateChange((s) => {
  console.log("auth:", s.isAuthenticated,
    s.expiresAt ? new Date(s.expiresAt).toISOString() : "unknown expiry");
});
```

Neither ever receives a token, so it is safe to forward these events to third-party analytics.

---

## Distributed tracing

Attach correlation ids with a per-request header:

```ts
await api.get("/users", {
  headers: { "X-Request-Id": crypto.randomUUID() },
});
```

Client-wide, for a session id:

```ts
const sessionId = crypto.randomUUID();
const api = createClient({
  baseUrl,
  headers: { "X-Session-Id": sessionId },
});
```

For W3C trace context, generate a `traceparent` per request:

```ts
function traceparent() {
  const hex = (n: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(n)))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  return `00-${hex(16)}-${hex(8)}-01`;
}

await api.post("/orders", body, { headers: { traceparent: traceparent() } });
```

---

## Measuring performance

`durationMs` is the simplest signal:

```ts
const slow: LogEntry[] = [];

const api = createClient({
  onLog: (e) => {
    if (e.durationMs > 1000) {
      slow.push(e);
      console.warn(`slow: ${e.method} ${e.url} took ${e.durationMs}ms`);
    }
  },
});
```

Aggregating by route — normalise ids out first, or your histogram has one bucket per user:

```ts
const stats = new Map<string, { n: number; total: number }>();

const api = createClient({
  onLog: (e) => {
    const route = new URL(e.url).pathname.replace(/\/\d+(?=\/|$)/g, "/:id");
    const key = `${e.method} ${route}`;
    const s = stats.get(key) ?? { n: 0, total: 0 };
    stats.set(key, { n: s.n + 1, total: s.total + e.durationMs });
  },
});

export const report = () =>
  [...stats].map(([k, s]) => ({ route: k, calls: s.n, avgMs: Math.round(s.total / s.n) }))
            .sort((a, b) => b.avgMs - a.avgMs);
```

---

## Debug recipe

```ts
export const api = createClient({
  baseUrl,
  onLog: (e) => console.log(
    `%c${e.method} ${e.statusCode} %c${e.url} %c${e.durationMs}ms`,
    `color:${e.status ? "green" : "red"};font-weight:bold`,
    "color:inherit", "color:gray",
  ),
  onError: (res) => console.groupCollapsed(`✗ ${res.statusCode} ${res.message}`)
    || console.log(res) || console.groupEnd(),
});

api.onAuthStateChange((s) => console.log("🔑", s));

if (typeof window !== "undefined") {
  (window as any).api = api; // poke at it from the console
}
```

---

## What never gets logged

- Access tokens and refresh tokens
- The `Authorization` header
- Request bodies
- Response bodies (only `message` and `statusCode` reach `LogEntry`)

`res.data` *is* available in the `onError` envelope, so if you forward it to a third party, scrub PII yourself.

Next: **[[Security Model]]**
