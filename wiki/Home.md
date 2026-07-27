# @mrzr/api-client

A typed REST client built on `fetch` with **zero runtime dependencies**.

Automatic token refresh, Web Worker isolation so tokens never touch the main thread, and cross-tab auth sync — in one `createClient()` call that works the same everywhere.

```bash
npm install @mrzr/api-client
```

```ts
import { createClient } from "@mrzr/api-client";

export const api = createClient({ baseUrl: "https://api.example.com" });

const { data } = await api.get<User[]>("/users");
```

---

## Why this client

| | |
|---|---|
| **Zero dependencies** | Nothing but the platform `fetch`. No `axios`, no `qs`, no polyfills. |
| **Runs anywhere** | React, Vue, Svelte, Angular, Next.js, Nuxt, SvelteKit, plain `<script>`, Node 18+, Deno, Bun, Cloudflare Workers. |
| **One request engine** | The worker and the main thread execute the *same* compiled code, so behaviour can never drift between modes. |
| **Concurrency-safe refresh** | 50 simultaneous 401s trigger exactly **one** refresh call — a shared promise, not a polling loop. |
| **Drop-in for TanStack Query / SWR** | Failures reject with a typed `ApiError`; switch to a never-throwing envelope with one flag. |
| **Real upload support** | `FormData`, `File`, `Blob`, `ArrayBuffer`, typed arrays and `ReadableStream`, with token refresh handled mid-upload. |
| **CSRF double-submit** | Built in, for cookie auth. |
| **~10 KB** | min+gzip, tree-shakeable, ESM + CJS + full types. |

---

## Documentation map

### Getting started
- **[[Installation]]** — install, requirements, framework notes
- **[[Quick Start]]** — your first client and request
- **[[Core Concepts]]** — the envelope, the engine, the execution modes

### Making requests
- **[[Requests]]** — `get`/`post`/`put`/`patch`/`delete`, URL building, params
- **[[Request Config]]** — every per-request option, explained
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
