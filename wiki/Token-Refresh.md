# Token Refresh

Two mechanisms, both automatic.

---

## Reactive: 401 → refresh → retry

When a request returns **401**, the client refreshes and replays it once.

```
Request ─→ 401 ─→ refresh() ─→ retry with the new token ─→ result
```

Rules:

- Only **one** retry. A second 401 is returned as-is, so a broken server can't loop.
- Skipped when `skipAuth: true` or `refreshTokenCheck: false`.
- The retry gets a **fresh timeout budget**.
- If refresh fails, the original 401 is returned and `onAuthFailure` fires.

## Proactive: refresh before expiry

Before sending, if the access token expires within `refreshSkewMs` (default **30 000 ms**), the client refreshes first — saving a wasted round trip.

```ts
createClient({ refreshSkewMs: 30_000 }); // default
createClient({ refreshSkewMs: 0 });      // disable; rely on 401s only
createClient({ refreshSkewMs: 120_000 }); // for slow or long-running requests
```

Proactive refresh runs only when **all** of these hold:

- the effective skew is greater than `0`
- `authMode` is `"header"` (in cookie mode the client can't read the expiry)
- both an access token **and** a refresh token exist
- the token's known expiry falls inside the window

An **opaque token** — one with no readable JWT `exp` — is never considered expired, so it is never proactively refreshed. The server decides via a 401.

---

## Concurrency: exactly one refresh

```
Request A ─ 401 ─┐
Request B ─ 401 ─┼─→ ONE refresh call ─→ all three retried with the new token
Request C ─ 401 ─┘
```

`AuthStore.coalesceRefresh` keeps the in-flight promise and hands the *same* promise to every concurrent caller:

```ts
coalesceRefresh(task) {
  if (this.inFlight) return this.inFlight;
  this.inFlight = task().finally(() => { this.inFlight = null; });
  return this.inFlight;
}
```

Fifty simultaneous 401s → one network call, no polling, no artificial delay. Across tabs, `BroadcastChannel` leader election narrows it further — see [[Multi-Tab Sync]].

---

## The refresh request

By default:

```http
POST {baseUrl}{refreshUrl}
Content-Type: application/json
Credentials: per authMode

{ "refresh": "<refreshToken>" }
```

Client-wide `headers` are merged in. In header mode with **no** refresh token, the call is skipped entirely — it can't succeed — and auth fails immediately.

### Customising the body

```ts
createClient({
  buildRefreshBody: (refresh) => ({ refresh_token: refresh, grant_type: "refresh_token" }),
});
```

Cookie mode, where the token lives in an httpOnly cookie:

```ts
createClient({
  authMode: "cookie",
  buildRefreshBody: () => ({}), // empty body; the cookie carries everything
});
```

### Customising the response mapping

```ts
createClient({
  refreshUrl: "/api/v1/auth/token/refresh/",
  extractTokens: (body) => {
    const b = body as { result?: { jwt: string; renew: string; ttl: number } };
    if (!b.result) return null;
    return {
      accessToken: b.result.jwt,
      refreshToken: b.result.renew,
      expiresAt: Date.now() + b.result.ttl * 1000,
    };
  },
});
```

Return `null` when the body contains no tokens; the client treats that as a failed refresh (in header mode) and clears auth.

`extractTokens` is used by **both** `login()` and `refresh()`, so one function covers both.

> ⚠️ `extractTokens` and `buildRefreshBody` are functions and cannot be structured-cloned into a Web Worker. Supplying either **automatically disables worker mode**. See [[Web Worker Isolation]].

---

## What counts as a successful refresh

| Situation | Outcome |
|---|---|
| Non-2xx response | Failure → clear auth, broadcast logout, `onAuthFailure` |
| Network error / JSON parse failure | Failure → same |
| Tokens extracted | Success → store, broadcast `refreshed`, return the new access token |
| No tokens, `authMode: "cookie"` | **Success** — the server rotated httpOnly cookies; returns `""` |
| No tokens, `authMode: "header"` | Failure → clear auth |

---

## Manual refresh

```ts
const token = await api.refresh();
// string  → new access token ("" in cookie mode)
// null    → refresh failed; auth has been cleared
```

Rarely needed — the automatic paths cover normal use. It is handy for a "keep me signed in" heartbeat or right before a long operation:

```ts
setInterval(() => { void api.refresh(); }, 10 * 60_000);
```

Concurrent manual calls are coalesced with automatic ones, so this is safe.

---

## Long uploads

`uploadSkewMs` is a per-request override of the proactive window:

```ts
await api.post("/upload", form, {
  uploadSkewMs: 10 * 60_000, // refresh now if the token dies within 10 minutes
  timeout: 0,
});
```

It works even when the client-wide `refreshSkewMs` is `0`, because it expresses a request-specific need. Full details in [[Uploads and Binary Bodies]].

---

## JWT utilities

The expiry helpers are exported for your own use:

```ts
import { getTokenExpiry, isTokenExpired } from "@mohammadreza-zr/api-client";

getTokenExpiry(token);          // epoch ms, or null if not a readable JWT
isTokenExpired(token);          // boolean; false when expiry is unknown
isTokenExpired(token, 60_000);  // "will it be expired a minute from now?"
```

They decode base64url in browsers, workers and Node (via `atob` or `Buffer`), reconstruct UTF-8 so non-ASCII claims survive, and **never verify the signature** — verification is the server's job, and doing it client-side would be security theatre.

`getTokenExpiry` returns `null` for anything that isn't a three-part JWT with a numeric `exp`, and `isTokenExpired` returns `false` in that case — "unknown" is not "expired".

---

## Refresh-token rotation

If your server issues a **new refresh token** with each refresh, it just works: `extractTokens` returns both, and `AuthStore.apply` updates both. Only the keys present in the returned pair are overwritten, so returning access-only leaves the existing refresh token intact.

With rotation plus multi-tab, race conditions become a real risk — two tabs presenting the same refresh token, one of them getting rejected. Leader election plus refresh coalescing prevents this for tabs of the same origin sharing storage. Keep `multiTab: true` and use a shared storage kind (`"local"` or `"cookie"`) if you enable rotation.

---

## Failure handling

When refresh fails permanently:

1. Tokens are cleared.
2. `logout` is broadcast — every other tab clears too.
3. `onAuthFailure()` fires.
4. `onAuthStateChange` emits `{ isAuthenticated: false }`.
5. The original request's result (usually the 401) is returned or thrown.

```ts
createClient({
  onAuthFailure: () => {
    queryClient.clear();
    router.push("/login?reason=session-expired");
  },
});
```

---

## Debugging refresh

```ts
const api = createClient({
  baseUrl,
  onAuthStateChange: undefined,
  onLog: (e) => console.log(`[api] ${e.method} ${e.url} → ${e.statusCode} (${e.durationMs}ms)`),
});

api.onAuthStateChange((s) =>
  console.log("auth:", s.isAuthenticated, s.expiresAt && new Date(s.expiresAt).toISOString()),
);

await api.get("/me", { log: true });
```

Common causes of a refresh loop:

| Symptom | Likely cause |
|---|---|
| Refresh fires on every request | Server returns an already-expired token, or `expiresAt` is in seconds where ms was expected |
| Refresh never fires | Opaque token (no `exp`) — expected; the 401 path still works |
| Immediate logout after login | `extractTokens` returns `null` for your response shape |
| 401 loop | Your refresh endpoint itself returns 401 — set `refreshTokenCheck: false` on any manual auth calls |

Next: **[[Storage Adapters]]**
