# Web Worker Isolation

By default every request runs inside a Web Worker created from an **inlined blob** — no extra file to host, no bundler configuration, no `?worker` import.

```ts
const api = createClient({ baseUrl });  // worker: true is the default
api.isWorker;                            // true in a supporting browser
```

---

## What it buys you

Tokens live in the **worker's closure**. They are never posted to the main thread, never written to `localStorage`, never stored in a page-scope variable.

```
┌─ Main thread ──────────────┐        ┌─ Web Worker ─────────────────┐
│                            │        │                              │
│  your app code             │        │  CoreClient                  │
│  api.get("/users") ────────┼─post──▶│    AuthStore { accessToken } │
│                            │        │    executeRequest()          │
│  ◀── IRes (no tokens) ─────┼────────│      └─ fetch()              │
│  ◀── AuthState (no tokens) │        │                              │
└────────────────────────────┘        └──────────────────────────────┘
```

An XSS payload running on your page has no variable to read and no storage key to dump. It cannot exfiltrate the token.

**What crosses the boundary:**

| Direction | Payload |
|---|---|
| Host → worker | Serializable options, method, URL, body, serializable config |
| Worker → host | `IRes` envelopes, `AuthState`, `LogEntry`, ready/failure signals |

Never a token, in either direction.

---

## How it's built

`scripts/build-worker.ts` bundles `src/worker/worker-entry.ts` into a single minified IIFE and inlines it as a string in `src/worker/worker-source.ts`. At runtime:

```ts
const blob = new Blob([WORKER_SOURCE], { type: "text/javascript" });
const worker = new Worker(URL.createObjectURL(blob));
```

Because the worker bundles the **same** `CoreClient` and `executeRequest` the main thread uses, the two modes cannot drift. A behaviour verified on one is verified on the other; `verify/worker.mjs` asserts this against a live server.

`destroy()` terminates the worker and revokes the object URL.

---

## When it disables itself

Worker mode is skipped — silently, falling back to the identical main-thread implementation — when **any** of these hold:

| Condition | Why |
|---|---|
| `worker: false` | You opted out |
| `typeof window === "undefined"` | SSR / Node: no `Worker` |
| `Worker`, `Blob` or `URL.createObjectURL` missing | Unsupported runtime |
| `extractTokens` supplied | Functions can't be structured-cloned |
| `buildRefreshBody` supplied | Same |
| Worker construction throws (CSP blocks `blob:`) | Caught, falls back |

Always check what you actually got:

```ts
if (!api.isWorker) console.warn("running on the main thread");
```

### Content Security Policy

Blob workers need:

```
Content-Security-Policy: worker-src 'self' blob:;
```

Older browsers fall back to `child-src blob:`. Without it, `new Worker(blobUrl)` throws, the client catches it, and you get the main-thread path with no error.

---

## Things that behave differently in worker mode

### 1. Function options don't cross

`extractTokens` and `buildRefreshBody` disable worker mode entirely. These are applied on the **host** instead, so they keep working:

| Option | Handling |
|---|---|
| `beforeFunc` | Applied on the main thread before the body is posted in |
| `afterFunc` | Applied on the main thread after the result comes back |
| `beforeSelectOptions` | Same |
| `getCsrfToken` | Called on the main thread; the resulting string is forwarded |
| `onAuthStateChanged` / `onAuthFailure` / `onError` / `onLog` | Invoked on the main thread from worker messages |

Observable behaviour is identical.

### 2. `ReadableStream` bodies are rejected

A stream cannot be structured-cloned. Rather than an opaque `DataCloneError` from `postMessage`, you get:

> A ReadableStream body cannot be sent through a Web Worker. Create this client with `worker: false`, or send a Blob/File/FormData instead.

`FormData`, `File`, `Blob`, `ArrayBuffer` and typed arrays are all transferable and work fine.

### 3. CSRF cookies are read on the host

Workers have no `document`. The host reads `document.cookie` (or calls your `getCsrfToken`) and mirrors the value into the request headers before posting. See [[CSRF Protection]].

### 4. Storage is owned by the host

`localStorage`, `sessionStorage` and `document.cookie` are Window APIs that simply don't exist in a worker. So the adapter — whether a string kind or your own object — is built on the **main thread**, and the worker persists through it over an internal `storage` message.

Every kind therefore behaves the same in both modes, and sessions survive a reload.

`"memory"` is the exception: it stays inside the worker and the bridge is never used, so tokens never reach the main thread at all. That's what makes it the safest option, and it's why it remains the default.

> Before v1.0.2 the worker built the adapter itself. `localStorage` doesn't exist there, so `"local"`, `"session"` and `"cookie"` silently discarded every write and users were logged out on each reload.

---

## Cancellation across the boundary

`AbortSignal` is not cloneable, so the host strips it and manages cancellation by message. The cancel registry lives on the host for the same reason — plus `api.cancel()` has to be synchronous and work before the worker has even booted:

```
host: api.get(url, { signal })
      └─ signal.onabort → postMessage({ kind: "abort", id, reason })
      └─ api.cancel(selector) → same message, for every match
worker: controller.abort(CancelError) → the real fetch is aborted
```

Cancellation is genuine, not cosmetic — the network request really stops and the socket closes. `pending()` is answered from the host, so it stays synchronous too. See **[[Cancellation]]**.

---

## Lifecycle

```ts
const api = createClient({ baseUrl });
// → worker constructed, `init` posted, `ready` awaited before the first request

await api.get("/users");

api.destroy();
// → `destroy` posted → worker aborts pending requests and self-closes
// → worker.terminate(), pending promises reject with "Client destroyed"
// → object URL revoked, listeners cleared
```

Always `destroy()` short-lived clients (per-request server clients, test setups) to avoid leaking a worker.

---

## Cost

| | |
|---|---|
| Worker bundle | ~14 KB minified, inlined in the main bundle |
| Startup | One blob + worker construction, a few ms |
| Per request | Two `postMessage` hops; structured clone of the body and result |

For large binary bodies the clone is a real copy. If you upload very large `ArrayBuffer`s in a tight loop, benchmark against `worker: false`.

---

## Opting out

```ts
createClient({ worker: false });
```

Reasonable when you're streaming request bodies, you need custom storage, you're on the server, or your CSP forbids blob workers and you'd rather be explicit than rely on the fallback.

---

## Honest limits

> Worker isolation prevents token **theft**. It cannot stop an attacker who already has XSS from *using* your client to make requests on the user's behalf.

If an attacker controls your page, they can call `api.post("/transfer", …)` and the worker will happily attach the token. What they *cannot* do is take the token somewhere else — to another origin, another session, or a long-lived attack after the tab closes.

That is a meaningful reduction in blast radius, not a substitute for a strict CSP, output encoding, and dependency hygiene. See **[[Security Model]]**.

Next: **[[Multi-Tab Sync]]**
