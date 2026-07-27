# Troubleshooting

---

## Error messages, decoded

### `addToUrl contains a falsy segment at index 0: [null]`

A segment was `null`, `undefined` or `""` — almost always an unresolved ID.

```ts
api.get("/users", { addToUrl: [userId] }); // userId is undefined
```

Guard, or use a template:

```ts
if (!userId) return;
api.get("/users/{id}", { addTemplateToUrl: { id: userId } });
```

`0` is explicitly allowed — it's a valid ID.

---

### `A ReadableStream body cannot be sent through a Web Worker.`

Streams aren't structured-cloneable. Three fixes, best first:

```ts
await api.post("/upload", file);                       // send a Blob/File instead
const streamApi = createClient({ baseUrl, worker: false });  // a dedicated client
const api = createClient({ baseUrl, worker: false });  // disable the worker
```

See [[Uploads and Binary Bodies]].

---

### `Access token expired during a streamed upload and the stream cannot be replayed.`

A 401 hit mid stream-upload. The token **has** been refreshed, so retrying with a fresh stream succeeds. Prevent it with `uploadSkewMs`:

```ts
await api.post("/upload", makeStream(), { uploadSkewMs: 600_000, timeout: 0 });
```

---

### `Request timed out` (`statusCode: 408`)

The per-attempt budget elapsed (default 30 s).

```ts
await api.get("/report", { timeout: 120_000 });
await api.post("/upload", form, { timeout: 0 }); // no limit
```

Remember the budget is per attempt — a 401 + retry can take twice as long in wall-clock terms.

---

### `Request aborted` (`statusCode: 0`)

Your `AbortSignal` fired, or `destroy()` was called. Usually intentional (navigation, a superseded search). Filter it out:

```ts
catch (e) {
  if (e instanceof ApiError && e.statusCode === 0 && e.message === "Request aborted") return;
  throw e;
}
```

---

### `Network request failed` (`statusCode: 0`)

The request never reached the server. Causes, in order of likelihood:

1. **CORS** — check the browser console for the real reason; the JS error is deliberately vague.
2. **Offline** — `navigator.onLine`.
3. **Bad `baseUrl`** — log `api` config, or watch the Network tab.
4. **Mixed content** — an `http:` API from an `https:` page.
5. **DNS / connection refused** — the server isn't up.

```ts
const res = await api.get("/health", { throwError: false, skipAuth: true });
console.log(res.statusCode, res.message, res.error);
```

---

### Requests go to my own app instead of the API

Symptom: a `GET /users` shows up in the Network tab as `https://my-app.com/users` and returns your `index.html` (or a 404 from your own router) rather than hitting the API.

That means `baseUrl` resolved to `""`. Check what it actually resolved to:

```ts
import { detectBaseUrl } from "@mrzr/api-client";

console.log(JSON.stringify(detectBaseUrl())); // "" means nothing was found
```

Common causes:

- **The variable isn't exposed to the client.** Browser bundlers only inline names with the right prefix. `API_URL` works on the server but is stripped from the browser bundle — use `NEXT_PUBLIC_API_URL`, `VITE_API_URL`, `NUXT_PUBLIC_API_URL` or `PUBLIC_API_URL`.
- **You used a custom variable name.** Auto-detection only knows the names listed in [[Client Options]]. Pass it yourself: `createClient({ baseUrl: import.meta.env.MY_API })`.
- **Config is loaded at runtime**, after the bundle was built. Set `globalThis.__API_BASE_URL__` before creating the client, or pass `baseUrl` explicitly.
- **The dev server wasn't restarted** after editing `.env`. Most bundlers only read it at startup.

Being explicit always beats detection:

```ts
export const api = createClient({ baseUrl: import.meta.env.VITE_API_URL });
```

> Fixed in v1.0.2. Earlier versions only read env vars through a *dynamic* `process.env[key]` index, which bundlers cannot inline and browsers don't have — so auto-detection always returned `""` on the client, and in worker mode regardless of environment.

---

### `Worker not initialized`

A request was made before the worker signalled `ready`, or after `destroy()`. The client awaits readiness internally, so this almost always means the client was destroyed and then reused. Create a new one.

---

### `Client destroyed`

Pending promises reject with this when `destroy()` is called. Make sure you aren't destroying a shared module-level client from a component unmount.

---

## Behaviour problems

### `api.isWorker` is `false` in the browser

Check, in order:

1. `worker: false` in your options.
2. A **custom storage object** — `storage: { get, set, clear }` disables the worker.
3. `extractTokens` or `buildRefreshBody` supplied — same.
4. CSP blocking `blob:` — add `worker-src 'self' blob:`.
5. SSR — expected; `window` is undefined.

```ts
console.log({
  isWorker: api.isWorker,
  hasWorkerAPI: typeof Worker !== "undefined",
  hasBlobURL: typeof URL?.createObjectURL === "function",
});
```

---

### Tokens vanish on reload

`storage: "memory"` is the default and is intentionally non-persistent. Options:

```ts
createClient({ storage: "local" });   // persists, but readable by page scripts
```

Better: keep `"memory"` and mint a fresh access token on boot from a long-lived httpOnly refresh cookie:

```ts
await api.refresh();
```

See [[Security Model]].

---

### Refresh fires on every request

Your token looks perpetually near-expiry. Likely causes:

- `expiresAt` returned in **seconds** where ms is expected. The default extractor disambiguates values below `1e12`, but a custom `extractTokens` must do so itself.
- Server clock skew larger than `refreshSkewMs`.
- The refresh endpoint returns an already-expired token.

```ts
console.log(new Date((await api.getAuthState()).expiresAt ?? 0).toISOString());
```

---

### Refresh never fires

- **Opaque token** — no readable JWT `exp`, so the client can't predict expiry. Expected; the 401 path still works. Supply `expiresAt` explicitly in `setTokens` if you know it.
- `refreshSkewMs: 0` disables the proactive path.
- No refresh token stored — check `login()` actually extracted one.
- Cookie mode — proactive refresh is skipped by design.

---

### Immediately logged out after logging in

`extractTokens` returned `null` for your response shape. Log the raw body:

```ts
const res = await api.post("/auth/login", creds, { skipAuth: true, fullData: true });
console.log(JSON.stringify(res.data, null, 2));
```

Then write a matching extractor:

```ts
createClient({
  extractTokens: (b: any) => ({ accessToken: b?.result?.jwt, refreshToken: b?.result?.renew }),
  worker: false, // required: functions can't cross the worker boundary
});
```

---

### 401 loop

Your refresh endpoint is itself returning 401, and the client is retrying it. Mark your auth calls:

```ts
await api.post("/auth/verify", body, { refreshTokenCheck: false, skipAuth: true });
```

The built-in `refresh()` never recurses (it uses raw `fetch`), so a loop means a manual call is involved.

---

### `res.data` is the whole envelope, not the payload

Unwrapping only happens when the body has a top-level `data` key. If your server returns `{ payload: … }`, unwrap yourself:

```ts
await api.get("/users", { afterFunc: (d: any) => d.payload });
```

Conversely, if you *want* the wrapper, pass `fullData: true`.

---

### `res.data` is `undefined` on success

Legitimate cases: a 204, an empty body, or a non-JSON response that failed to parse. Check `res.headers?.["content-type"]` and `res.statusCode`.

---

### Field errors are missing

The client reads `errors` from the top level of the response body:

```json
{ "message": "Validation failed", "errors": { "email": ["taken"] } }
```

Nested elsewhere? Map them:

```ts
catch (e) {
  if (e instanceof ApiError) {
    const errors = (e.data as any)?.detail?.fields ?? e.errors;
  }
}
```

---

### Multi-tab sync isn't working

- `multiTab: false` set.
- No `BroadcastChannel` (old Safari) — the client degrades to single-tab.
- Different `storageKey`s across your clients means different channels — that may be intentional.
- Different **origins** never share a channel; `localhost:3000` and `localhost:3001` are separate.

Watch the traffic:

```ts
new BroadcastChannel("apiclient.auth").onmessage = (e) => console.log(e.data);
```

---

### A Node process won't exit

`BroadcastChannel` is a ref'd handle. The client never opens one on the server, but if you constructed a client in a browser-like test environment, call `destroy()`:

```ts
afterEach(() => api.destroy());
```

Also pass `worker: false, multiTab: false` in tests.

---

### CSRF header isn't being sent

Checklist:

- Is the method unsafe? `GET` never gets the header, by design.
- Is `xsrfCookieName` or `getCsrfToken` configured?
- Is the cookie readable (i.e. **not** httpOnly)?
- In worker mode, does `getCsrfToken` work on the main thread?
- Did you set the header explicitly per-request? Yours wins.

```ts
console.log(document.cookie);                          // is the cookie there?
createClient({ getCsrfToken: () => { const t = read(); console.log("csrf:", t); return t; } });
```

---

### Cookies aren't sent cross-origin

Requires all of:

```ts
createClient({ authMode: "cookie" }); // sets credentials: "include"
```
```
Set-Cookie: session=…; HttpOnly; Secure; SameSite=None
Access-Control-Allow-Origin: https://app.example.com   (never *)
Access-Control-Allow-Credentials: true
```

`SameSite=None` **requires** `Secure`, which requires HTTPS — including in local development.

---

### Uploads arrive as `{"0":72,"1":105}`

You're on an old version, or you converted the body yourself. Current versions detect typed arrays via `ArrayBuffer.isView()`. Verify:

```ts
await api.post("/upload", new Uint8Array([72, 105]), {
  headers: { "Content-Type": "application/octet-stream" },
});
```

---

### `Content-Type` is wrong on an upload

Precedence: per-request header → non-JSON client header → the body's own type. If a stale `application/json` is sticking, you probably set it client-wide. Override per request:

```ts
await api.post("/upload", form, { headers: { "Content-Type": "" } });
```

Or drop it from the client defaults and set it only where you send JSON.

---

## Debug checklist

```ts
const api = createClient({
  baseUrl,
  onLog: (e) => console.log("[api]", e),
  onError: (r) => console.error("[api error]", r),
  onAuthStateChanged: (s) => console.log("[auth]", s),
  onAuthFailure: () => console.warn("[auth] failed"),
});

console.log("worker:", api.isWorker);
console.log("state:", await api.getAuthState());

await api.get("/health", { log: true, skipAuth: true, throwError: false });
```

Then check the Network tab for the actual request URL, headers and response — the client is a thin layer over `fetch`, so the truth is always visible there.

---

## Still stuck?

Open an [issue](https://github.com/mohammadreza-zr/api-client/issues) with:

- Package version, runtime and framework
- Your `createClient` options (with secrets removed)
- The failing call and the full `IRes` / `ApiError`
- `api.isWorker`
- A minimal reproduction, ideally against `https://httpbin.org`

Next: **[[FAQ]]**
