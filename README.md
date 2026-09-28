# @mrzr/api-client

A TypeScript-first API client focused on secure browser auth: coalesced token refresh, Web Worker token isolation, and cross-tab session sync. Zero runtime dependencies, works in every JS runtime.

```bash
npm install @mrzr/api-client
```

```ts
import { createClient } from "@mrzr/api-client";

export const api = createClient({ baseUrl: "https://api.example.com" });

// Tokens are captured, stored, refreshed and rotated across tabs for you.
await api.login({ email, password });
const { data } = await api.get<User[]>("/users");
```

---

## Is this for you?

**Use it if** any of these are real problems for you:

- Your access token expires and 20 concurrent requests each fire their own refresh
- You want tokens off the main thread, where XSS can't read them
- Logging out in one tab should log out the others
- You use httpOnly cookies and can't tell on page load whether a session exists
- You need refresh to work *during* a five-minute file upload

**Use something else if not.** For a small `fetch` wrapper with built-in retry, use [ky](https://github.com/sindresorhus/ky). For the widest legacy support and ecosystem, use axios. Neither focuses on browser auth.

---

## How it compares

| | axios | ky | @mrzr/api-client |
|---|---|---|---|
| Zero runtime dependencies | ✗ | ✓ | ✓ |
| Built on | XHR / node:http | fetch | fetch |
| Retry with backoff | via `axios-retry` | **✓ built in** | ✗ *(not yet)* |
| Interceptors / hooks | **✓ global** | **✓ global** | ✓ global, via [plugins](https://github.com/mohammadreza-zr/api-client/wiki/Plugins) |
| **Coalesced token refresh** | build it yourself | build it yourself | **✓ built in** |
| **Web Worker token isolation** | ✗ | ✗ | **✓** |
| **Cross-tab auth sync** | ✗ | ✗ | **✓** |
| **httpOnly cookie session restore** | ✗ | ✗ | **✓** |
| **Cancel by URL pattern / scope** | ✗ | ✗ | **✓** |
| CSRF double-submit | partial | ✗ | ✓ |

An honest note on that table:

- **Retry.** Not implemented. It has to interact correctly with refresh-and-retry, cancellation and `takeLatest`, and shipping it half-right would be worse than not shipping it.

---

## What it actually does

- **Coalesced refresh** — 50 simultaneous 401s trigger exactly **one** refresh call. A shared promise, not a polling loop
- **Web Worker isolation** — requests run in a worker by default, so tokens never enter the main-thread heap. Self-disables on the server or where `Worker` is missing
- **Cross-tab sync** — login, logout and refresh propagate over `BroadcastChannel`, and tabs take turns refreshing (Web Locks), so a rotating refresh token is never spent twice
- **httpOnly cookie mode** — including `restoreSession()`, which answers the "am I logged in?" question that cookies make unanswerable from JS
- **Opt-in cancellation** — cancel by URL pattern, scope or key on page change or modal close; real aborts, worker mode included
- **Real upload support** — `FormData`, `File`, `Blob`, typed arrays and streams, with refresh handled mid-upload
- **CSRF double-submit** — built in, for cookie auth
- **Plugins** — optional add-ons that cost nothing until imported, like `services` for several APIs on one session ([guide](https://github.com/mohammadreza-zr/api-client/wiki/Plugins))
- **WebSockets / socket.io** — `getSocketToken(url)` hands a socket a server-issued ticket without exposing the access token; `getAccessToken()` is there behind `exposeTokens: true` ([guide](https://github.com/mohammadreza-zr/api-client/wiki/WebSockets-and-Socket.io))
- **One request engine** — the worker and main thread run the *same* compiled code, so behaviour can't drift between modes
- **Runs anywhere** — React, Vue, Svelte, Angular, Next.js, Nuxt, SvelteKit, plain `<script>`, Node 20+, Deno, Bun, Cloudflare Workers

---

## Works with your data library

It sits *under* TanStack Query, SWR or Vue Query — it doesn't replace them.

```ts
useQuery({
  queryKey: ["users"],
  queryFn: ({ signal }) => api.get<User[]>("/users", { signal }).then((r) => r.data),
});
```

Failures reject with a typed `ApiError`, which is what Query and SWR need to mark a request failed. Cancellation resolves instead, flagged with `canceled: true`, so a route change never looks like an error.

---

## Quick start

```ts
// lib/api.ts
import { createClient } from "@mrzr/api-client";

export const api = createClient({
  baseUrl: "https://api.example.com",
});
```

```ts
import { api } from "./lib/api";
import { ApiError } from "@mrzr/api-client";

try {
  const { data } = await api.get<User[]>("/users");
  console.log(data);
} catch (e) {
  if (e instanceof ApiError) console.error(e.statusCode, e.message);
}
```

Worker isolation, token refresh and tab sync are on by default, and turn themselves off where the runtime doesn't support them.

---

## 📚 Documentation

Full documentation lives in the **[Wiki](https://github.com/mohammadreza-zr/api-client/wiki)** — 28 pages covering every feature in depth.

| | |
|---|---|
| **Start here** | [Installation](https://github.com/mohammadreza-zr/api-client/wiki/Installation) · [Quick Start](https://github.com/mohammadreza-zr/api-client/wiki/Quick-Start) · [Core Concepts](https://github.com/mohammadreza-zr/api-client/wiki/Core-Concepts) |
| **Requests** | [Requests](https://github.com/mohammadreza-zr/api-client/wiki/Requests) · [Request Config](https://github.com/mohammadreza-zr/api-client/wiki/Request-Config) · [Cancellation](https://github.com/mohammadreza-zr/api-client/wiki/Cancellation) · [Responses & Errors](https://github.com/mohammadreza-zr/api-client/wiki/Responses-and-Errors) · [Uploads](https://github.com/mohammadreza-zr/api-client/wiki/Uploads-and-Binary-Bodies) |
| **Auth** | [Authentication](https://github.com/mohammadreza-zr/api-client/wiki/Authentication) · [Token Refresh](https://github.com/mohammadreza-zr/api-client/wiki/Token-Refresh) · [Storage](https://github.com/mohammadreza-zr/api-client/wiki/Storage-Adapters) · [CSRF](https://github.com/mohammadreza-zr/api-client/wiki/CSRF-Protection) |
| **Advanced** | [Worker Isolation](https://github.com/mohammadreza-zr/api-client/wiki/Web-Worker-Isolation) · [Multi-Tab Sync](https://github.com/mohammadreza-zr/api-client/wiki/Multi-Tab-Sync) · [WebSockets](https://github.com/mohammadreza-zr/api-client/wiki/WebSockets-and-Socket.io) · [Plugins](https://github.com/mohammadreza-zr/api-client/wiki/Plugins) · [Logging](https://github.com/mohammadreza-zr/api-client/wiki/Logging-and-Observability) · [Security Model](https://github.com/mohammadreza-zr/api-client/wiki/Security-Model) |
| **Reference** | [Client Options](https://github.com/mohammadreza-zr/api-client/wiki/Client-Options) · [API Reference](https://github.com/mohammadreza-zr/api-client/wiki/API-Reference) · [TypeScript Types](https://github.com/mohammadreza-zr/api-client/wiki/TypeScript-Types) |
| **Guides** | [Framework Recipes](https://github.com/mohammadreza-zr/api-client/wiki/Framework-Recipes) · [Cookbook](https://github.com/mohammadreza-zr/api-client/wiki/Cookbook) · [Migration](https://github.com/mohammadreza-zr/api-client/wiki/Migration-Guide) · [Troubleshooting](https://github.com/mohammadreza-zr/api-client/wiki/Troubleshooting) · [FAQ](https://github.com/mohammadreza-zr/api-client/wiki/FAQ) |

Upgrading from 2.x? 3.0.0 has breaking changes — see the [changelog](https://github.com/mohammadreza-zr/api-client/blob/main/CHANGELOG.md).

---

## Requirements

Any runtime with `fetch` and `AbortController`: all modern browsers, Node 20+, Deno, Bun, Cloudflare Workers.

## License

MIT
