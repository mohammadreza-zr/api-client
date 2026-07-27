# Storage Adapters

Storage decides whether tokens survive a page reload — and how exposed they are.

> Storage applies to **header mode only**. In `authMode: "cookie"` the tokens live in httpOnly cookies owned by your server, so no local adapter is created.

---

## The built-ins

```ts
createClient({ storage: "memory" });   // default
createClient({ storage: "local" });
createClient({ storage: "session" });
createClient({ storage: "cookie" });
```

| Kind | Survives reload | Shared across tabs | Readable by page JS | XSS exposure |
|---|---|---|---|---|
| `"memory"` | ❌ | ❌ | ❌ (worker mode) | **None** in worker mode |
| `"session"` | ✅ (same tab) | ❌ | ✅ | High |
| `"local"` | ✅ | ✅ | ✅ | High |
| `"cookie"` | ✅ (7 days) | ✅ | ✅ | High + sent on every request |

> **How persistence works in worker mode.** `localStorage`, `sessionStorage` and `document.cookie` are Window APIs with no worker equivalent, so the worker cannot write them itself. The adapter therefore lives on the **main thread**, and the worker persists through it over an internal bridge.
>
> This is why choosing a persistent kind is also a security decision: the tokens necessarily pass through the main thread to be written somewhere page scripts can already read. `"memory"` keeps its bridge switched off entirely, so tokens never leave the worker — that guarantee is unchanged, and covered by `verify/storage.mjs`.

Keys are namespaced by `storageKey` (default `"apiclient"`), so the token record lives at `apiclient.tokens` and the cross-tab channel at `apiclient.auth`.

```ts
createClient({ storageKey: "acme-admin" }); // isolate two clients on one origin
```

---

## `"memory"` — the default, and the safest

Tokens live in a closure. Nothing is written anywhere; a reload signs the user out.

Combined with the default worker mode, that closure is **inside the worker**, so no page script — including an injected one — can reach it. This is the strongest configuration that doesn't require httpOnly cookies.

The obvious cost is the reload. Mitigations:

- Use **cookie mode** with httpOnly cookies (best).
- Keep a long-lived httpOnly refresh cookie and call `api.refresh()` on boot to mint a fresh in-memory access token.
- Accept `"local"` and defend hard against XSS with a strict CSP.

---

## `"local"` / `"session"`

`localStorage` persists until cleared and is shared across tabs of the origin. `sessionStorage` is per-tab and dies with it.

Both are **readable by any script on the origin**. One XSS and your tokens are exfiltrated. Worker isolation cannot help here — the whole point of these adapters is that the value is in a place page scripts can read.

The adapter handles the sharp edges: Safari private mode (which throws on access), quota-exceeded errors, and corrupt JSON all degrade to a null read instead of an exception.

---

## `"cookie"`

A **non-httpOnly** cookie holding the JSON token record, so SSR can read it.

```
apiclient.tokens={"accessToken":"…"}; Expires=…; Path=/; SameSite=Lax; Secure
```

`Secure` is added automatically on `https:`. `SameSite=Lax` is always set. Default lifetime is 7 days.

Use it when the server needs to read tokens during SSR. Be aware the cookie is sent on **every** request to the origin, which grows your request size.

> This is *not* the same as `authMode: "cookie"`. This adapter stores a client-readable cookie in header mode. Cookie **mode** uses httpOnly cookies your server sets and never exposes.

---

## Custom adapters

Implement three methods; each may be sync or async.

```ts
interface TokenStorage {
  get(): Promise<TokenPair | null> | TokenPair | null;
  set(tokens: TokenPair): Promise<void> | void;
  clear(): Promise<void> | void;
}
```

```ts
createClient({
  storage: {
    get: () => JSON.parse(myStore.read() ?? "null"),
    set: (tokens) => myStore.write(JSON.stringify(tokens)),
    clear: () => myStore.remove(),
  },
});
```

> A custom adapter **keeps worker mode**. The object itself stays on the main thread — it is never cloned into the worker — and the worker calls it over the storage bridge. Your `get`/`set`/`clear` therefore run on the main thread, and may be sync or async.
>
> (Before v1.0.2 an adapter object silently forced inline mode, because it couldn't be structured-cloned.)

Errors thrown from an adapter are swallowed — corrupt or unavailable storage is never fatal.

### React Native (`AsyncStorage`)

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";

createClient({
  baseUrl,
  worker: false,
  multiTab: false,
  storage: {
    async get() {
      const raw = await AsyncStorage.getItem("auth");
      return raw ? JSON.parse(raw) : null;
    },
    set: (t) => AsyncStorage.setItem("auth", JSON.stringify(t)),
    clear: () => AsyncStorage.removeItem("auth"),
  },
});
```

### Expo SecureStore (encrypted at rest)

```ts
import * as SecureStore from "expo-secure-store";

createClient({
  worker: false,
  multiTab: false,
  storage: {
    async get() {
      const raw = await SecureStore.getItemAsync("auth");
      return raw ? JSON.parse(raw) : null;
    },
    set: (t) => SecureStore.setItemAsync("auth", JSON.stringify(t)),
    clear: () => SecureStore.deleteItemAsync("auth"),
  },
});
```

### Encrypted `localStorage`

Encrypting `localStorage` with a key that also lives in the page is **not** a security control — XSS gets both. It only defends against casual inspection. If you need real protection, use httpOnly cookies.

```ts
createClient({
  worker: false,
  storage: {
    get: () => { try { return JSON.parse(decrypt(localStorage.getItem("t") ?? "")); } catch { return null; } },
    set: (t) => localStorage.setItem("t", encrypt(JSON.stringify(t))),
    clear: () => localStorage.removeItem("t"),
  },
});
```

### IndexedDB

```ts
import { get, set, del } from "idb-keyval";

createClient({
  worker: false,
  storage: {
    get: () => get("auth").then((v) => v ?? null),
    set: (t) => set("auth", t),
    clear: () => del("auth"),
  },
});
```

---

## Using the adapter classes directly

```ts
import { MemoryStorage, WebStorage, CookieStorage } from "@mrzr/api-client";

new MemoryStorage();
new WebStorage("myapp.tokens", "local");    // or "session"
new CookieStorage("myapp.tokens", 30);      // 30-day lifetime
```

Handy for composing an adapter — for example a session-scoped store that falls back to memory when storage is blocked:

```ts
class Fallback implements TokenStorage {
  private mem = new MemoryStorage();
  private web = new WebStorage("app.tokens", "session");
  get() { return this.web.get() ?? this.mem.get(); }
  set(t: TokenPair) { this.web.set(t); this.mem.set(t); }
  clear() { this.web.clear(); this.mem.clear(); }
}
```

---

## Hydration timing

On construction the client kicks off `storage.get()` and stores the promise. Every request `await`s it before sending, so a request issued in the first tick still carries the persisted token.

`getAuthState()` awaits it too — which is why you should gate your UI on it rather than rendering an unauthenticated shell first:

```ts
const state = await api.getAuthState(); // safe: hydration has completed
```

---

## Choosing

```
Do you control the backend and share a site?
├─ yes → authMode: "cookie" with httpOnly cookies          ← most secure
└─ no  → header mode
         ├─ Can users tolerate re-login on reload?
         │   └─ yes → storage: "memory" + worker: true     ← safest header setup
         └─ no
             ├─ Long-lived httpOnly refresh cookie available?
             │   └─ yes → "memory" + api.refresh() on boot ← nearly as safe
             └─ no → "local" + a strict CSP                ← convenient, riskier
```

See **[[Security Model]]** for the reasoning.

Next: **[[CSRF Protection]]**
