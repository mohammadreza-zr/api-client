# @mrzr/api-client

**The HTTP layer under TanStack Query, SWR and Vue Query — it handles authentication so they don't have to.**

A TypeScript-first API client focused on secure browser auth: coalesced token refresh, Web Worker token isolation, and cross-tab session sync. Zero runtime dependencies.

```bash
npm install @mrzr/api-client
```

```ts
import { createClient } from "@mrzr/api-client";

export const api = createClient({ baseUrl: "https://api.example.com" });

await api.login({ email, password });
const { data } = await api.get<User[]>("/users");
```

---

## Is this for you?

Most HTTP clients treat auth as something you bolt on with interceptors. This one treats it as the product.

**Use it if** any of these are real problems:

- An expired token makes 20 concurrent requests each fire their own refresh
- You want tokens off the main thread, where XSS can't read them
- Logging out in one tab should log out the others
- You use httpOnly cookies and can't tell on page load whether a session exists
- You need refresh to work *during* a five-minute upload

**Use something else if not.** For a small `fetch` wrapper, [ky](https://github.com/sindresorhus/ky) is excellent — a third of the size, built-in retry. For the biggest ecosystem and legacy support, axios. Neither is trying to solve browser auth, and this isn't trying to out-ky ky.

---

## How it compares

Including the rows where this library loses.

| | axios | ky | @mrzr/api-client |
|---|---|---|---|
| Zero runtime dependencies | ✗ | ✓ | ✓ |
| Bundle, min+gzip | ~14 KB | **~4 KB** | 13.4 KB |
| Built on | XHR / node:http | fetch | fetch |
| Retry with backoff | via `axios-retry` | **✓ built in** | ✗ *(not yet)* |
| Interceptors / hooks | **✓ global** | **✓ global** | per-request transforms |
| **Coalesced token refresh** | build it yourself | build it yourself | **✓ built in** |
| **Web Worker token isolation** | ✗ | ✗ | **✓** |
| **Cross-tab auth sync** | ✗ | ✗ | **✓** |
| **httpOnly cookie session restore** | ✗ | ✗ | **✓** |
| **Cancel by URL pattern / scope** | ✗ | ✗ | **✓** |
| CSRF double-submit | partial | ✗ | ✓ |

- **Size.** 13.4 KB is axios-territory and 3× ky. ~3.8 KB of it is the inlined worker, which ships even with `worker: false` — a runtime flag can't be tree-shaken.
- **Retry.** Not implemented. It has to interact correctly with refresh-and-retry, cancellation and `takeLatest`; shipping it half-right would be worse than not shipping it.

---

## What it actually does

| | |
|---|---|
| **Coalesced refresh** | 50 simultaneous 401s trigger exactly **one** refresh call — a shared promise, not a polling loop. |
| **Worker isolation** | Requests run in a Web Worker by default, so tokens never enter the main-thread heap. |
| **Cross-tab sync** | Login, logout and refresh propagate over `BroadcastChannel`, with leader election. |
| **httpOnly cookie mode** | Including `restoreSession()`, which answers the "am I logged in?" question cookies make unanswerable from JS. |
| **Opt-in cancellation** | Cancel by URL pattern, scope or key on page change or modal close. Real aborts, worker mode included. |
| **Real upload support** | `FormData`, `File`, `Blob`, `ArrayBuffer`, typed arrays and `ReadableStream`, with refresh handled mid-upload. |
| **One request engine** | The worker and main thread run the *same* compiled code, so behaviour can never drift. |
| **Runs anywhere** | React, Vue, Svelte, Angular, Next.js, Nuxt, SvelteKit, plain `<script>`, Node 20+, Deno, Bun, Cloudflare Workers. |

---

## Works with your data library

It sits *under* TanStack Query, SWR or Vue Query — it doesn't replace them.

```ts
useQuery({
  queryKey: ["users"],
  queryFn: ({ signal }) => api.get<User[]>("/users", { signal }).then((r) => r.data),
});
```

Failures reject with a typed `ApiError`, which is what Query and SWR need to mark a request failed. Cancellation resolves instead, flagged `canceled: true`, so a route change never looks like an error.

---

## Documentation map

### Getting started
- **[[Installation]]** — install, requirements, framework notes
- **[[Quick Start]]** — your first client and request
- **[[Core Concepts]]** — the envelope, the engine, the execution modes

### Making requests
- **[[Requests]]** — `get`/`post`/`put`/`patch`/`delete`, URL building, params
- **[[Request Config]]** — every per-request option, explained
- **[[Cancellation]]** — cancel on page change, modal close or a new keystroke
- **[[Responses and Errors]]** — `IRes`, `ApiError`, throwing vs. envelope
- **[[Uploads and Binary Bodies]]** — FormData, Blob, streams, long uploads

### Authentication
- **[[Authentication]]** — header mode, cookie mode, login/logout, seeding tokens
- **[[Token Refresh]]** — reactive 401 retry, proactive refresh, custom token shapes
- **[[Storage Adapters]]** — memory/local/session/cookie and custom adapters
- **[[CSRF Protection]]** — double-submit, worker-mode caveats

### Advanced
- **[[Web Worker Isolation]]** — how it works, what it protects, when it disables itself
- **[[Multi-Tab Sync]]** — BroadcastChannel, leader election
- **[[Logging and Observability]]** — `log`, `onLog`, `onError`
- **[[Security Model]]** — the threat model, honestly stated

### Reference & recipes
- **[[Client Options]]** — the full `ClientOptions` table
- **[[API Reference]]** — every export, signature by signature
- **[[TypeScript Types]]** — the complete public type surface
- **[[Framework Recipes]]** — React, TanStack Query, SWR, Next.js, Nuxt, Svelte, Angular, Node
- **[[Cookbook]]** — practical patterns and snippets
- **[[Migration Guide]]** — coming from axios, or from an older envelope-style setup
- **[[Troubleshooting]]** — every error message and what to do about it
- **[[FAQ]]** — short answers to common questions
- **[[Contributing]]** — repo layout, build pipeline, verification suite

---

## The 60-second tour

```ts
import { createClient, ApiError } from "@mrzr/api-client";

const api = createClient({
  baseUrl: "https://api.example.com",
  storage: "memory",   // safest default
  worker: true,        // tokens never reach the main thread
  multiTab: true,      // tabs stay in sync
});

// Log in — tokens are captured and stored for you
await api.login({ email: "a@b.com", password: "secret" });

// Typed request with URL templating and nested query params
const { data } = await api.get<User[]>("/orgs/{org}/users", {
  addTemplateToUrl: { org: "acme" },
  params: { page: 1, filter: { active: true } },
});

// Failures reject with a typed error
try {
  await api.post("/orders", { sku: "X" });
} catch (e) {
  if (e instanceof ApiError) console.error(e.statusCode, e.errors);
}

await api.logout();  // clears tokens in every tab
```

---

## License

MIT © mohammadreza-zr
