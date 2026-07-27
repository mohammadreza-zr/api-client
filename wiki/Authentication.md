# Authentication

The client owns your tokens. You never attach an `Authorization` header, never read storage, never pass a token into a request.

---

## Two modes

| | `authMode: "header"` (default) | `authMode: "cookie"` |
|---|---|---|
| Credential | `Authorization: Bearer <token>` | httpOnly cookie set by your server |
| `credentials` | `"same-origin"` | `"include"` |
| Client sees the token | Yes | **No** |
| XSS can steal the token | Only if `storage` is readable — see [[Storage Adapters]] | No |
| CSRF risk | None (headers aren't sent cross-site automatically) | Yes → use [[CSRF Protection]] |
| Cross-origin setup | Simple | Needs `SameSite=None; Secure` + CORS `Access-Control-Allow-Credentials` |
| Best for | SPAs, mobile web, third-party APIs | Same-site apps where you control the backend |

---

## Header mode

```ts
const api = createClient({
  baseUrl: "https://api.example.com",
  authMode: "header",   // the default
  storage: "memory",    // "memory" | "local" | "session" | "cookie"
  loginUrl: "/auth/login",
  refreshUrl: "/auth/refresh",
  logoutUrl: "/auth/logout",
});

await api.login({ email: "a@b.com", password: "secret" });
const me = await api.get<User>("/me");   // Authorization attached automatically
await api.logout();
```

## Cookie mode

Your server sets `HttpOnly; Secure; SameSite` cookies. The client never sees a token — it just sends `credentials: "include"`.

```ts
const api = createClient({
  baseUrl: "https://api.example.com",
  authMode: "cookie",
  xsrfCookieName: "csrftoken",   // strongly recommended — see CSRF Protection
});

await api.login({ email, password }); // server sets the cookies
const me = await api.get<User>("/me");
```

In cookie mode:
- No local storage adapter is created — there's nothing to persist.
- Proactive refresh is skipped (the client can't read the token's expiry), so refresh is driven by 401s.
- A refresh response with no body still counts as success: the server rotated the cookies.

Server-side requirements for cross-origin cookie auth:

```
Set-Cookie: access=…; HttpOnly; Secure; SameSite=None; Path=/
Access-Control-Allow-Origin: https://app.example.com   (not *)
Access-Control-Allow-Credentials: true
```

---

## `login()`

```ts
const res = await api.login<LoginPayload>({ email, password });
```

What it does:

1. `POST` to `loginUrl` with `skipAuth: true`, `refreshTokenCheck: false`, `fullData: true`.
2. Runs `extractTokens` over the full response body and stores whatever it finds.
3. Runs the user extractor (`user` at the top level, or under `data` / `result` / `payload`) and stores it in `AuthState`.
4. Broadcasts `login` to other tabs.
5. Re-applies your unwrapping preference to the returned `data`.

The default extractor understands a lot of shapes out of the box:

```jsonc
{ "access": "…",       "refresh": "…" }
{ "access_token": "…", "refresh_token": "…" }
{ "accessToken": "…",  "refreshToken": "…" }
{ "token": "…" }
{ "jwt": "…" }
{ "idToken": "…" }
// …and all of the above nested under "data", "tokens", "result" or "payload"
```

Expiry is read from `expiresAt`, `expires_at`, `expiresIn`, `expires_in` or `expiry` — durations in seconds are converted to absolute timestamps, and second-vs-millisecond timestamps are disambiguated. Failing that, it is decoded from the JWT `exp` claim.

Custom shape? See [[Token Refresh]] for `extractTokens`.

> `login()` obeys `throwError` like any other request — bad credentials reject with an `ApiError` carrying `401` and the server's message.

```ts
try {
  await api.login({ email, password });
  router.push("/dashboard");
} catch (e) {
  if (e instanceof ApiError && e.statusCode === 401) {
    setError("Wrong email or password");
  }
}
```

---

## `logout()`

```ts
await api.logout();
```

1. `POST` to `logoutUrl` with the refresh body, `refreshTokenCheck: false`, `hideErrorMessage: true`.
2. Clears tokens locally **whether or not the request succeeded**.
3. Broadcasts `logout` to every other tab, which clear immediately.

Logging out locally matters more than the round trip, so `logout()` **never throws** — a network failure still logs you out.

Local-only logout (no server call):

```ts
await api.setTokens({ accessToken: undefined, refreshToken: undefined });
```

---

## `setTokens()` — seeding from elsewhere

For SSR hydration, an OAuth callback, or a login flow you implemented yourself:

```ts
await api.setTokens({
  accessToken,
  refreshToken,
  expiresAt: Date.now() + 3600_000, // optional; derived from the JWT if omitted
});
```

Only the keys you pass are updated — omit `refreshToken` and the existing one is kept. This broadcasts `login` to other tabs.

**OAuth callback:**

```ts
const params = new URLSearchParams(location.hash.slice(1));
await api.setTokens({
  accessToken: params.get("access_token")!,
  refreshToken: params.get("refresh_token") ?? undefined,
});
history.replaceState(null, "", location.pathname);
```

**Next.js SSR hydration:**

```ts
// server component
const token = (await cookies()).get("access_token")?.value;
return <Providers token={token}>{children}</Providers>;

// client provider
useEffect(() => {
  if (token) void api.setTokens({ accessToken: token });
}, [token]);
```

---

## Auth state

```ts
interface AuthState {
  isAuthenticated: boolean;      // has an access token that isn't expired
  expiresAt: number | null;      // epoch ms, or null for opaque tokens
  user?: unknown;                // whatever login/refresh returned as `user`
}
```

**Never contains tokens.** That is the invariant that makes worker isolation meaningful.

```ts
const state = await api.getAuthState();

const stop = api.onAuthStateChange((state) => {
  if (!state.isAuthenticated) router.push("/login");
});
stop(); // unsubscribe
```

`onAuthStateChange` fires on login, logout, refresh, `setTokens`, `setUser`, and when another tab changes state. Listener exceptions are caught, so one bad subscriber can't break auth.

> `isAuthenticated` is `true` for an *opaque* (non-JWT) token, because the client can't know its expiry. It lets the server decide via a 401.

### `onAuthFailure`

Fires when auth is **permanently lost** — refresh rejected, logout, or another tab logging out. This is your redirect hook.

```ts
createClient({
  onAuthFailure: () => {
    queryClient.clear();
    router.push("/login?reason=expired");
  },
});
```

`onAuthStateChange` reports every transition; `onAuthFailure` reports only the terminal one.

---

## A React auth provider

```tsx
import { createContext, useContext, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AuthState } from "@mohammadreza-zr/api-client";

const AuthCtx = createContext<AuthState & { ready: boolean }>({
  isAuthenticated: false, expiresAt: null, ready: false,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ isAuthenticated: false, expiresAt: null });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void api.getAuthState().then((s) => {
      if (alive) { setState(s); setReady(true); }
    });
    const stop = api.onAuthStateChange(setState);
    return () => { alive = false; stop(); };
  }, []);

  return <AuthCtx.Provider value={{ ...state, ready }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
```

The `ready` flag matters: `getAuthState()` awaits storage hydration, so before it resolves you don't yet know whether the user is signed in. Render a splash screen until then, or you'll flash the login page on every reload.

---

## A Vue composable

```ts
import { ref, onUnmounted } from "vue";
import { api } from "@/lib/api";

export function useAuth() {
  const state = ref({ isAuthenticated: false, expiresAt: null as number | null });
  const ready = ref(false);

  void api.getAuthState().then((s) => { state.value = s; ready.value = true; });
  const stop = api.onAuthStateChange((s) => { state.value = s; });
  onUnmounted(stop);

  return { state, ready };
}
```

---

## Custom endpoint paths

```ts
createClient({
  loginUrl: "/api/v1/auth/token/",
  refreshUrl: "/api/v1/auth/token/refresh/",
  logoutUrl: "/api/v1/auth/token/blacklist/",
});
```

Paths are joined onto `baseUrl`. Absolute URLs work too, if auth lives on a different host.

Next: **[[Token Refresh]]**
