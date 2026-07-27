# CSRF Protection

## Why it's needed

Cookie auth means the browser attaches your session cookie to **cross-site** requests too. A malicious page can submit a form to your API and the cookie rides along. That is CSRF.

Header auth (`Authorization: Bearer`) is immune — an attacker's page cannot set that header on your behalf. So **CSRF protection matters when `authMode: "cookie"`**.

## The double-submit pattern

1. Your server sets a CSRF token in a **readable** (non-httpOnly) cookie.
2. The client echoes it back in a **header** on state-changing requests.
3. Your server compares the two and rejects mismatches.

An attacker's page can *trigger* a request, but the same-origin policy stops it from *reading* your cookie — so it cannot forge the header.

**Your backend does the enforcement.** This client automates the browser half.

---

## Setup

```ts
const api = createClient({
  authMode: "cookie",
  xsrfCookieName: "csrftoken",     // the cookie your server sets
  xsrfHeaderName: "X-CSRF-Token",  // the header to mirror it into (default)
});

await api.post("/orders", body); // X-CSRF-Token attached automatically
```

That's the whole client-side configuration.

### Framework header names

| Backend | Cookie | Header |
|---|---|---|
| Django | `csrftoken` | `X-CSRFToken` |
| Laravel | `XSRF-TOKEN` | `X-XSRF-TOKEN` |
| Rails | `CSRF-TOKEN` | `X-CSRF-Token` |
| Spring Security | `XSRF-TOKEN` | `X-XSRF-TOKEN` |
| ASP.NET Core | `XSRF-TOKEN` | `X-XSRF-TOKEN` |

```ts
// Django
createClient({ authMode: "cookie", xsrfCookieName: "csrftoken", xsrfHeaderName: "X-CSRFToken" });

// Laravel Sanctum
createClient({ authMode: "cookie", xsrfCookieName: "XSRF-TOKEN", xsrfHeaderName: "X-XSRF-TOKEN" });
```

---

## Behaviour details

- **Only unsafe methods** get the header: `POST`, `PUT`, `PATCH`, `DELETE`. `GET` is a safe method and is left alone.
- **An explicit per-request header always wins** — you can override it anywhere.
- **Missing token → no header.** The request still goes out; your server rejects it if it requires one.
- **A throwing `getCsrfToken` is caught** and treated as "no token", so a broken provider can't break every request.
- Header comparison is **case-insensitive**, so your explicit `x-csrf-token` beats the configured `X-CSRF-Token`.

---

## When the token isn't in a readable cookie

A `<meta>` tag, an in-memory value fetched at boot, or **worker mode** — where `document.cookie` does not exist. Supply it directly:

```ts
createClient({
  getCsrfToken: () =>
    document.querySelector<HTMLMetaElement>("meta[name=csrf-token]")?.content,
});
```

`getCsrfToken` **takes precedence** over `xsrfCookieName`.

### Worker mode requires `getCsrfToken`

Web Workers have no `document`, so a cookie read is impossible inside one. The client solves this by resolving the token **on the main thread** and forwarding the resulting string with each request.

That resolution happens through `getCsrfToken` — a function can't be structured-cloned into a worker, so the host calls it and posts the value across.

```ts
// ✅ works in worker mode
createClient({
  authMode: "cookie",
  getCsrfToken: () => readCookie("csrftoken"),
});

// ⚠️ xsrfCookieName alone: the worker host also reads document.cookie on the
// main thread, so this works too — but an explicit provider is clearer and
// covers meta tags and in-memory tokens as well.
createClient({ authMode: "cookie", xsrfCookieName: "csrftoken" });
```

A small helper:

```ts
function readCookie(name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
  if (!m) return undefined;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}
```

---

## Bootstrapping the token

Many backends require you to fetch the cookie once before the first mutation.

```ts
// Laravel Sanctum
const api = createClient({
  baseUrl: "https://api.example.com",
  authMode: "cookie",
  xsrfCookieName: "XSRF-TOKEN",
  xsrfHeaderName: "X-XSRF-TOKEN",
});

await api.get("/sanctum/csrf-cookie"); // seeds the cookie
await api.post("/login", { email, password });
```

```ts
// Django
await api.get("/api/csrf/"); // an endpoint whose view calls get_token(request)
```

Fetching a token from an endpoint into memory:

```ts
let csrf: string | undefined;

const api = createClient({
  authMode: "cookie",
  getCsrfToken: () => csrf,
});

async function bootstrap() {
  const res = await api.get<{ token: string }>("/csrf", { skipAuth: true });
  csrf = res.data?.token;
}
```

---

## Overriding per request

```ts
await api.post("/special", body, {
  headers: { "X-CSRF-Token": oneOffToken },
});
```

The client sees a header already set and leaves it alone.

---

## Server-side checklist

The client half is one line. The server half is where the security lives:

- [ ] Compare the cookie value against the header value on every unsafe method; reject on mismatch with `403`.
- [ ] Set the CSRF cookie with `SameSite=Lax` (or `Strict`) and `Secure`.
- [ ] The CSRF cookie must **not** be httpOnly — the client has to read it. Your *session* cookie should be.
- [ ] Rotate the CSRF token on login and on privilege changes.
- [ ] Use a cryptographically random, per-session token.
- [ ] Restrict CORS to explicit origins (never `*` with `Access-Control-Allow-Credentials: true`).
- [ ] Prefer `SameSite=Lax` on the session cookie too; use `None` only when you genuinely need cross-site requests, and always with `Secure`.

## When you don't need any of this

Using `authMode: "header"`? You don't need CSRF protection at all — an attacker's page cannot attach your `Authorization` header. Configuring `xsrfCookieName` in header mode is harmless but pointless.

Next: **[[Web Worker Isolation]]**
