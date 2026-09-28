# Multi-Tab Sync

Tabs coordinate auth over `BroadcastChannel`.

```ts
createClient({ multiTab: true });  // default
createClient({ multiTab: false }); // opt out
```

The channel name is `${storageKey}.auth`, i.e. `apiclient.auth` by default.

Sync runs from wherever the client runs — including inside the Web Worker, which has its own `BroadcastChannel`.

> Fixed in v1.0.2: the runtime check treated any scope without `window` as the server, and a worker has no `window`. So in the default worker mode the channel was never opened and **cross-tab sync silently did nothing**. Tabs only converged on the next 401.

Sync also relies on tabs sharing storage, so pair it with a persistent kind — with the default `"memory"` each tab keeps its own tokens and only `logout` propagates.

### Cookie mode

`authMode: "cookie"` works with multi-tab sync, and needs no `storage` setting: the httpOnly cookie is scoped to the origin, so **every tab already shares one session** by construction. The channel is only there to tell the other tabs that it changed.

| Event in tab A | Tab B |
|---|---|
| `login()` | becomes authenticated |
| refresh | stays authenticated |
| `logout()` | becomes logged out |

One caveat: `state.user` is not broadcast — it is never persisted or sent over the channel in either auth mode. A tab that learns about a login from a sibling knows it is authenticated but has no user object until it fetches one:

```ts
api.onAuthStateChange(async (state) => {
  if (state.isAuthenticated && !state.user) {
    await api.restoreSession("/api/auth/me");   // fills in `user`
  }
});
```

> Fixed in v1.0.2: cookie mode has no shared storage to re-read, so the "another tab signed in" path did nothing and only `logout` propagated.

---

## What it solves

| Without sync | With sync |
|---|---|
| Log out in tab A, tab B keeps making authenticated calls until its next 401 | Every tab clears immediately |
| Five tabs wake from sleep and all refresh at once | One tab leads; the others adopt the result |
| Tab A refreshes and rotates the refresh token; tab B's copy is now invalid | Tab B re-reads shared storage and stays current |

---

## Messages

Three message types cross the channel. **None carries a token.**

```ts
type TabMessage =
  | { type: "login";     tabId: string; expiresAt: number | null }
  | { type: "refreshed"; tabId: string; expiresAt: number | null }
  | { type: "logout";    tabId: string };
```

Booleans, timestamps and a random tab id — that's it. A compromised tab learns nothing it doesn't already have.

Each tab ignores its own messages, matched on `tabId`.

---

## Reactions

| Received | Effect |
|---|---|
| `logout` | Clear tokens locally, fire `onAuthFailure` |
| `login` / `refreshed` | Re-hydrate from shared storage, then emit `AuthState` |

Re-hydration is why storage kind matters: with `"local"` or `"cookie"` the other tab genuinely picks up the rotated tokens. With `"memory"` or `"session"` there's nothing shared to re-read, so each tab has its own session. An explicit `logout()` still signs every tab out. A failed refresh does not: it only ends that tab's own session, since the others never shared it.

| Storage | `logout()` propagates | A rejected refresh propagates | Refreshed tokens propagate |
|---|---|---|---|
| `"memory"` | ✅ | ❌ (independent sessions) | ❌ (nothing shared) |
| `"session"` | ✅ | ❌ (per-tab) | ❌ (per-tab) |
| `"local"` | ✅ | ✅ | ✅ |
| `"cookie"` | ✅ | ✅ | ✅ |

In `authMode: "cookie"` the browser already holds the rotated httpOnly cookie, so every tab is current by construction.

---

## Tabs take turns refreshing

With a rotating refresh token, two tabs refreshing at once would present the same token twice; the server reads that as reuse and revokes the session. So refreshes are serialized across tabs with the [Web Locks API](https://developer.mozilla.org/docs/Web/API/Web_Locks_API) (`navigator.locks`, available in windows and workers):

```
tab A ── lock ── refresh → new pair saved ── unlock
tab B ── wait ─────────────────────────────── lock ── sees A's new pair → adopts it, no request
```

Once it holds the lock, a tab first checks whether a sibling already refreshed while it waited — a newer refresh token in shared storage, or in cookie mode a sibling's `refreshed` message — and adopts that result instead of spending the token again. The winning tab persists its new tokens before releasing the lock, so the next tab always sees them.

The browser releases a lock when its tab closes, so a tab killed mid-refresh never blocks the others. Where Web Locks is missing, or `multiTab` is off, each tab simply refreshes on its own.

Within a single tab, refresh coalescing is exact: `AuthStore.coalesceRefresh` guarantees one call. See [[Token Refresh]].

---

## Server safety

The channel is **never opened** when `typeof window === "undefined"`. This is not cosmetic: Node's `BroadcastChannel` is a ref'd handle that keeps the event loop alive, which would hang SSR renders, CLIs and test runners forever.

Where the API exists in a non-browser runtime, the client also calls `channel.unref?.()` as a second line of defence.

---

## Failure modes are non-fatal

- No `BroadcastChannel` → the client behaves as a single tab.
- Channel construction throws → caught; sync is disabled.
- `postMessage` on a closed channel → caught.
- A listener throws → caught; the other listeners still run.

---

## Isolating clients on one origin

Two apps on the same origin — an admin panel and a customer app — should not share auth. Give them different `storageKey`s:

```ts
export const adminApi    = createClient({ storageKey: "acme-admin" });
export const customerApi = createClient({ storageKey: "acme-app" });
```

Different keys mean different storage entries **and** different channels, so they're fully independent.

---

## Reacting to another tab's logout

```ts
api.onAuthStateChange((state) => {
  if (!state.isAuthenticated) {
    queryClient.clear();
    router.push("/login");
  }
});
```

This fires whether the logout happened here or in another tab — the handler doesn't need to care.

A dedicated notice:

```ts
let wasAuthed = false;
api.onAuthStateChange((s) => {
  if (wasAuthed && !s.isAuthenticated) {
    toast.info("You were signed out in another tab.");
  }
  wasAuthed = s.isAuthenticated;
});
```

---

## Testing it

Open your app in two tabs:

1. Log in on tab A → tab B's `onAuthStateChange` fires with `isAuthenticated: true`.
2. Log out on tab A → tab B clears immediately and `onAuthFailure` fires.
3. With `storage: "local"`, force a refresh on tab A → tab B picks up the new `expiresAt`.

Programmatically:

```ts
const channel = new BroadcastChannel("apiclient.auth");
channel.onmessage = (e) => console.log("tab message:", e.data);
```

You'll see the `login`, `refreshed` and `logout` traffic — and confirm for yourself that no token ever appears in it.

Next: **[[Logging and Observability]]**
