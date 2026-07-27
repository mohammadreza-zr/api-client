# Security Model

An honest account of what this client protects against, and what it doesn't.

---

## Threat model

| Threat | Protection | Effectiveness |
|---|---|---|
| **Token theft via XSS** | Worker isolation + memory storage | **Strong** — no readable variable, no storage key |
| **Token use via XSS** | None | **None** — see below |
| **CSRF** | Double-submit header mirroring | **Strong**, if your server enforces it |
| **Token leakage in logs** | Tokens never enter `LogEntry`, `AuthState` or tab messages | **Strong** |
| **Cross-tab desync** | BroadcastChannel logout propagation | **Strong** |
| **Refresh stampede** | Promise coalescing + leader election | **Strong** |
| **MITM** | Not addressed — use HTTPS | n/a |
| **Malicious dependency** | Zero runtime dependencies | **Strong** |

---

## The uncomfortable truth about XSS

> Worker isolation prevents token **theft**. It cannot stop an attacker who already has XSS from *using* your client.

An injected script can call `api.post("/transfer", { to: "attacker" })` and the worker will attach the token. Isolation stops one specific thing: the token leaving the browser.

Why that still matters:

| Without isolation | With isolation |
|---|---|
| Token exfiltrated to the attacker's server | Token stays in the worker |
| Attack continues after the tab closes | Attack dies with the page |
| Token replayed from anywhere | Requests must originate from your page |
| Refresh token stolen → indefinite access | Refresh token never leaves |

You go from *"the attacker owns this account indefinitely"* to *"the attacker can act while the user has the tab open"*. Meaningful, but not a substitute for preventing XSS.

**Prevent XSS first.** Isolation is defence in depth, not a replacement for a strict CSP, output encoding and dependency hygiene.

---

## Storage, ranked

```
Most secure
│
├─ authMode: "cookie" + httpOnly cookies        ← the client never sees a token
├─ header + storage:"memory" + worker:true      ← token unreachable from page JS
├─ header + storage:"memory" + worker:false     ← in a main-thread closure
├─ header + storage:"session"                   ← readable by any page script
├─ header + storage:"local"                     ← readable, and persistent
└─ header + storage:"cookie" (non-httpOnly)     ← readable, and sent everywhere
│
Least secure
```

Reload behaviour is the trade-off:

| Setup | Survives reload? | Recovery |
|---|---|---|
| Cookie mode | ✅ | The browser holds it |
| `"memory"` | ❌ | Call `api.refresh()` on boot against an httpOnly refresh cookie |
| `"session"` | ✅ same tab | – |
| `"local"` / `"cookie"` | ✅ | – |

The recommended header-mode setup — no re-login, no readable token:

```ts
// Server sets a long-lived httpOnly refresh cookie at login.
const api = createClient({
  baseUrl,
  storage: "memory",
  worker: true,
  buildRefreshBody: () => ({}), // the cookie carries the refresh token
  credentials: "include",
});

await api.refresh(); // mints a fresh in-memory access token on boot
```

> Note: `buildRefreshBody` disables worker mode. If you need both, have the server accept an empty JSON body by default so no custom builder is required.

---

## Recommended production configurations

### Maximum security — you control the backend, same site

```ts
createClient({
  baseUrl: "https://api.example.com",
  authMode: "cookie",
  xsrfCookieName: "csrftoken",
  xsrfHeaderName: "X-CSRF-Token",
});
```

Server:
```
Set-Cookie: session=…; HttpOnly; Secure; SameSite=Strict; Path=/
Set-Cookie: csrftoken=…; Secure; SameSite=Strict; Path=/
```

### Strong — SPA against a third-party API

```ts
createClient({
  baseUrl: "https://api.vendor.com",
  authMode: "header",
  storage: "memory",
  worker: true,
  refreshSkewMs: 30_000,
  onAuthFailure: () => router.push("/login"),
});
```

### Pragmatic — persistence required, XSS risk accepted

```ts
createClient({
  baseUrl,
  authMode: "header",
  storage: "local",
  worker: true, // still worth it: the *live* token stays in the worker
});
```

Pair with a strict CSP. Note that `"local"` means the persisted copy is readable regardless of worker mode.

---

## Content Security Policy

A CSP that supports this client and defends against XSS:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  worker-src 'self' blob:;
  connect-src 'self' https://api.example.com;
  style-src 'self';
  img-src 'self' data: https:;
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'none';
  upgrade-insecure-requests;
```

Key directives:

- `worker-src blob:` — required for worker isolation. Without it, the client silently falls back to the main thread.
- `connect-src` — restrict where `fetch` may go. This is what actually blocks exfiltration to an attacker's domain, and it's the directive that makes worker isolation hard to bypass.
- No `'unsafe-inline'`, no `'unsafe-eval'` — these are what make XSS trivially exploitable.

---

## What the client never does

- ❌ Put a token in a URL or query string
- ❌ Put a token in a log entry, an `AuthState`, or a tab message
- ❌ Verify a JWT signature (that's the server's job; client-side verification is theatre)
- ❌ Send `Authorization` cross-origin without your `baseUrl` pointing there
- ❌ Send the CSRF header on safe methods (`GET`)
- ❌ Retry a 401 more than once
- ❌ Store anything under a key you didn't configure (`storageKey`)

---

## Auditing your setup

```ts
const api = createClient(options);

console.table({
  isWorker: api.isWorker,          // false means no isolation — is that intended?
  authMode: options.authMode ?? "header",
  storage: options.storage ?? "memory",
  csrf: Boolean(options.xsrfCookieName || options.getCsrfToken),
  multiTab: options.multiTab !== false,
});
```

Checklist:

- [ ] `api.isWorker === true` in production browsers (or `worker: false` is a deliberate choice)
- [ ] `storage` is `"memory"`, or you've accepted the XSS exposure
- [ ] Cookie mode has CSRF configured **and** the server enforces it
- [ ] CSP includes `worker-src blob:` and a tight `connect-src`
- [ ] `baseUrl` is HTTPS in production
- [ ] `onAuthFailure` clears app caches (`queryClient.clear()`), not just the route
- [ ] Tokens are short-lived (15 min or less) with rotation on refresh
- [ ] No token appears in any analytics or error-reporting payload

---

## Reporting a vulnerability

Open a [security advisory](https://github.com/mohammadreza-zr/api-client/security/advisories/new) rather than a public issue.

Next: **[[Client Options]]**
