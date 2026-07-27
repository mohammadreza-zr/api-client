# Installation

```bash
npm install @mrzr/api-client
# or
pnpm add @mrzr/api-client
yarn add @mrzr/api-client
bun add @mrzr/api-client
```

The package ships **ESM + CJS + TypeScript declarations** and has **no runtime dependencies**.

---

## Requirements

Any runtime with `fetch` and `AbortController`:

| Runtime | Minimum |
|---|---|
| Node.js | 20 (enforced via `engines`) |
| Chrome / Edge | 80+ |
| Firefox | 78+ |
| Safari | 14+ |
| Deno | 1.x+ |
| Bun | 1.x+ |
| Cloudflare Workers | ✅ |

Optional capabilities degrade gracefully when missing:

| Capability | Used for | If missing |
|---|---|---|
| `Worker` + `Blob` + `URL.createObjectURL` | Worker isolation | Falls back to the identical main-thread implementation |
| `BroadcastChannel` | Multi-tab sync | Single-tab behaviour |
| `AbortSignal.any` | Combining timeout + user signal | Manual signal linking fallback |
| `localStorage` / `sessionStorage` | Persistent storage | Reads/writes become no-ops (Safari private mode is handled) |

---

## Module formats

| Entry | File |
|---|---|
| ESM | `dist/index.js` |
| CJS | `dist/index.cjs` |
| Types (ESM) | `dist/index.d.ts` |
| Types (CJS) | `dist/index.d.cts` |

```ts
// ESM / TypeScript / bundlers
import { createClient } from "@mrzr/api-client";
```

```js
// CommonJS
const { createClient } = require("@mrzr/api-client");
```

```html
<!-- No build step -->
<script type="module">
  import { createClient } from "https://esm.sh/@mrzr/api-client";
</script>
```

The package is marked `"sideEffects": false`, so bundlers tree-shake anything you don't import.

---

## TypeScript setup

No extra `@types` package is needed. For the best experience use:

```jsonc
{
  "compilerOptions": {
    "moduleResolution": "bundler", // or "node16" / "nodenext"
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "strict": true
  }
}
```

`moduleResolution: "node"` (the legacy default) also resolves correctly — the package exposes `main`/`module`/`types` alongside `exports`.

---

## Framework installation notes

### Next.js
No configuration needed. On the server, worker mode disables itself automatically. In server components and route handlers, prefer creating a short-lived client and calling `destroy()` — see [[Framework Recipes]].

### Vite / Nuxt / SvelteKit
No configuration needed. The worker is created from an inlined blob, so there is **no worker file to host** and no `?worker` import to wire up.

### Content Security Policy
Blob workers require `worker-src blob:` (or `child-src blob:`). If your CSP forbids it, the client catches the failure and silently runs on the main thread instead — nothing breaks, you just lose isolation. To be explicit about it, set `worker: false`.

```
Content-Security-Policy: worker-src 'self' blob:;
```

### React Native
`fetch` and `AbortController` exist, so requests work. `Worker`, `BroadcastChannel` and `localStorage` do not — pass `worker: false`, `multiTab: false`, and a [custom storage adapter](Storage-Adapters) backed by `AsyncStorage` or `expo-secure-store`.

---

## Verifying the install

```ts
import { createClient } from "@mrzr/api-client";

const api = createClient({ baseUrl: "https://httpbin.org" });
console.log(api.isWorker);            // true in a browser, false on the server
console.log((await api.get("/get")).status); // true
api.destroy();
```

Next: **[[Quick Start]]**
