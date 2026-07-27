# Responses and Errors

## The envelope

Every request resolves with the same shape:

```ts
interface IRes<R = unknown> {
  statusCode: number;                 // 0 when the request never reached the network
  status: boolean;                    // true for 2xx
  message: string;                    // server message, or a readable failure reason
  data?: R;                           // unwrapped from { data: ... } unless fullData
  loading: boolean;                   // always false on a settled response
  errors?: Record<string, string[]>;  // field-level validation errors
  error?: unknown;                    // the underlying thrown error, if any
  headers?: Record<string, string>;   // lowercased keys
}
```

`loading` is always `false` on a settled response. It exists so the same object can seed UI state without a second type:

```ts
const [res, setRes] = useState<IRes<User[]>>({
  statusCode: 0, status: false, message: "", loading: true,
});
```

---

## Status codes the client generates

Codes below come from the client, not the server:

| `statusCode` | `message` | Cause |
|---|---|---|
| `0` | `"Request aborted"` | Your `AbortSignal` fired, or `destroy()` was called |
| `0` | `"Network request failed"` | Offline, DNS failure, CORS rejection, bad URL |
| `0` | (stream/worker message) | A `ReadableStream` body was sent to a worker client |
| `408` | `"Request timed out"` | The per-attempt timeout elapsed |
| `401` | (stream retry message) | Token expired mid stream-upload; the stream can't replay |
| `500` | (worker error) | The worker itself failed |

Everything else is the real HTTP status.

---

## Body parsing

The parser is deliberately forgiving:

1. `204` / `205` → `data` is `undefined`.
2. `content-type` contains `json` → `response.json()`.
3. Otherwise → `response.text()`; empty text becomes `undefined`.
4. Non-empty text is *tried* as JSON anyway (many servers omit the header), and falls back to the raw string.
5. Any parse failure yields `undefined` rather than throwing.

So a plain-text `500 Internal Server Error` page never crashes your error handler.

### Where `message` and `errors` come from

If the parsed body is an object, the client reads:

- `message` → `res.message` (otherwise `""`, or `"Request failed with status N"` on failure)
- `errors` → `res.errors`

Recommended server shape:

```json
{
  "message": "Validation failed",
  "errors": { "email": ["already taken"], "age": ["must be positive"] }
}
```

### Automatic unwrapping

If the body has a `data` key, `res.data` is that value, not the wrapper. `fullData: true` disables this.

---

## Throwing: the default

**Failed requests reject with an `ApiError`.**

```ts
import { ApiError } from "@mrzr/api-client";

try {
  const { data } = await api.get<User>("/users/1");
  render(data!);
} catch (e) {
  if (e instanceof ApiError) {
    e.statusCode; // 404
    e.message;    // "User not found"
    e.errors;     // { email: ["already taken"] } | undefined
    e.data;       // parsed payload, if any
    e.response;   // the full IRes envelope
  } else {
    throw e;      // a real bug — a thrown transform, say
  }
}
```

### Why throwing is the default

Every mainstream data-fetching library detects failure through a rejected promise. With a never-throwing client:

```ts
// ❌ with throwError: false
useQuery({ queryFn: () => api.get("/users") });
// a 500 is "successful" — cached as data, no retry, no error UI
```

The repo's verification suite asserts this exact hazard in `verify/audit.mjs`, labelled `[documented] envelope-style 500 looks like SUCCESS to react-query`.

### The `ApiError` class

```ts
class ApiError extends Error {
  readonly name = "ApiError";
  readonly statusCode: number;
  readonly errors?: Record<string, string[]>;
  readonly data?: unknown;
  readonly response: IRes<unknown>;
}
```

`message` is the server's `message`, or `"Request failed with status N"` when the server sent none.

> Use `instanceof ApiError`. It is a real subclass with a stable `name`, so `e.name === "ApiError"` also works across bundle boundaries.

---

## The never-throwing envelope

Turn it off globally, per request, or both — per-request always wins.

```ts
const api = createClient({ throwError: false });

const res = await api.get<User[]>("/users");
if (!res.status) {
  console.error(res.statusCode, res.message);
  return;
}
render(res.data!);
```

```ts
// …except this one
await api.get("/critical", { throwError: true });
```

This style suits UI code that renders errors inline rather than catching them:

```vue
<script setup>
const res = await api.get("/users", { throwError: false });
</script>

<template>
  <ErrorBox v-if="!res.status" :message="res.message" />
  <UserList v-else :users="res.data" />
</template>
```

---

## Handling validation errors

```ts
try {
  await api.post("/users", form);
} catch (e) {
  if (e instanceof ApiError && e.statusCode === 422) {
    for (const [field, messages] of Object.entries(e.errors ?? {})) {
      setFieldError(field, messages[0]);
    }
    return;
  }
  throw e;
}
```

Envelope style:

```ts
const res = await api.post("/users", form, { throwError: false });
if (!res.status && res.errors) {
  Object.entries(res.errors).forEach(([f, m]) => setFieldError(f, m[0]));
}
```

---

## A reusable error mapper

```ts
export function describe(error: unknown): string {
  if (!(error instanceof ApiError)) return "Something went wrong.";

  switch (error.statusCode) {
    case 0:   return "You appear to be offline.";
    case 400: return error.message || "Invalid request.";
    case 401: return "Please sign in again.";
    case 403: return "You don't have permission to do that.";
    case 404: return "Not found.";
    case 408: return "The request timed out. Try again.";
    case 409: return error.message || "That conflicts with existing data.";
    case 422: return Object.values(error.errors ?? {}).flat()[0] ?? "Please check your input.";
    case 429: return "Too many requests. Slow down a moment.";
    default:  return error.statusCode >= 500
      ? "Something went wrong on our end."
      : error.message || "Request failed.";
  }
}
```

---

## Distinguishing abort from timeout

Both are "the request didn't finish", but they need different UI:

```ts
try {
  await api.get("/report", { signal, timeout: 5_000 });
} catch (e) {
  if (e instanceof ApiError) {
    if (e.statusCode === 408) return toast("Timed out — try again");
    if (e.statusCode === 0 && e.message === "Request aborted") return; // user navigated away
  }
}
```

---

## The client-wide `onError` hook

Fires for **every** failed request, regardless of `throwError`, unless `hideErrorMessage: true`.

```ts
const api = createClient({
  onError: (res) => {
    if (res.statusCode >= 500) Sentry.captureMessage(res.message);
    if (res.statusCode === 0) toast.error("You're offline");
  },
});
```

`onError` is for cross-cutting concerns — telemetry, offline banners. Per-call handling still belongs in your `catch`.

Next: **[[Uploads and Binary Bodies]]**
