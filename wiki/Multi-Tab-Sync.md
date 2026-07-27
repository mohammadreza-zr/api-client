# Multi-Tab Sync

Tabs coordinate auth over `BroadcastChannel`.

```ts
createClient({ multiTab: true });  // default
createClient({ multiTab: false }); // opt out
```

The channel name is `${storageKey}.auth`, i.e. `apiclient.auth` by default.

---

## What it solves

| Without sync | With sync |
|---|---|
| Log out in tab A, tab B keeps making authenticated calls until its next 401 | Every tab clears immediately |
| Five tabs wake from sleep and all refresh at once | One tab leads; the others adopt the result |
| Tab A refreshes and rotates the refresh token; tab B's copy is now invalid | Tab B re-reads shared storage and stays current |

---

## Messages

Four message types cross the channel. **None carries a token.**

```ts
type TabMessage =
  | { type: "login";     tabId: string; expiresAt: number | null }
  | { type: "refreshed"; tabId: string; expiresAt: number | null }
  | { type: "logout";    tabId: string }
  | { type: "claim";     tabId: string; at: number };
```

Booleans, timestamps and a random tab id — that's it. A compromised tab learns nothing it doesn't already have.

Each tab ignores its own messages, matched on `tabId`.

---

## Reactions

| Received | Effect |
|---|---|
| `logout` | Clear tokens locally, fire `onAuthFailure` |
| `login` / `refreshed` | Re-hydrate from shared storage, then emit `AuthState` |
| `claim` | Record the earliest claim to decide leadership |

Re-hydration is why storage kind matters: with `"local"` or `"cookie"` the other tab genuinely picks up the rotated tokens. With `"memory"` or `"session"` there's nothing shared to re-read, so tabs stay independent apart from logout — which still propagates, because clearing needs no shared value.

| Storage | Logout propagates | Refreshed tokens propagate |
|---|---|---|
| `"memory"` | ✅ | ❌ (nothing shared) |
| `"session"` | ✅ | ❌ (per-tab) |
| `"local"` | ✅ | ✅ |
| `"cookie"` | ✅ | ✅ |

In `authMode: "cookie"` the browser already holds the rotated httpOnly cookie, so every tab is current by construction.

---

## Leader election

When several tabs need to refresh at once, one should drive it. Before refreshing, a tab posts a `claim` with a timestamp. The **earliest** claim wins; ties break on the lexicographically smaller `tabId`, so the outcome is deterministic.

```
tab A ── claim(t=100) ──▶
tab B ── claim(t=103) ──▶
tab C ── claim(t=101) ──▶
                          → A leads
```

This is deliberately **best-effort**: every tab still awaits its own refresh call. Election reduces stampede in the common case, but a tab that loses the election isn't blocked — so if the leader is killed mid-flight (tab closed, throttled by the browser), the others still recover on their own. Correctness never depends on the election succeeding.

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

You'll see the `claim`, `login`, `refreshed` and `logout` traffic — and confirm for yourself that no token ever appears in it.

Next: **[[Logging and Observability]]**
