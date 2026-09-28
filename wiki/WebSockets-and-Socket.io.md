# WebSockets and socket.io

The client already holds the session, so a realtime connection can borrow it. There are two ways, and the first keeps worker isolation intact.

---

## Recommended: a socket ticket from your server

`api.getSocketToken(url)` calls an endpoint of yours through the client — authenticated, refreshed on 401, CSRF-protected — and returns the credential it answers with. The access token never leaves the worker; only the ticket does.

```ts
import { io } from "socket.io-client";

const socket = io("https://realtime.example.com", {
  // A function, so every (re)connection fetches a fresh ticket.
  auth: async (cb) => cb({ token: await api.getSocketToken("/auth/socket-ticket") }),
});
```

Anything your ticket endpoint returns reaches page code, so an injected script can request a ticket too. Make tickets **short-lived, single-use and valid only for the socket**, so one can't be replayed or used against the API. In worker mode the call never returns the session's own tokens: they are redacted from every response, and pointing `getSocketToken` at the configured login or refresh endpoint strips the token fields, so the call rejects.

This fits both cases:

- **The socket needs a different token** — your server mints it (a short-lived, single-use ticket is ideal).
- **The socket accepts the API token** — your endpoint can mint a *new*, short-lived token of the same kind. Echoing the session's current access token won't work in worker mode, since it is redacted; that case is what `exposeTokens` below is for.

The endpoint may answer with the token as a plain string, or as `{ token }`, `{ ticket }` or `{ socketToken }`, optionally wrapped in `{ data }`. It is called with `POST` by default; pass `{ method: "GET" }` for a GET endpoint. Any other [[Request Config]] option works too:

```ts
await api.getSocketToken("/auth/socket-ticket", { method: "GET", timeout: 5_000 });
```

It rejects with an [`ApiError`](Responses-and-Errors) when the call fails (for example `401` for a visitor with no session) or when the response carries no token.

A plain WebSocket takes the ticket in the URL or the first message, since browsers can't set headers on the handshake:

```ts
const ticket = await api.getSocketToken("/auth/socket-ticket");
const ws = new WebSocket(`wss://realtime.example.com/?ticket=${encodeURIComponent(ticket)}`);
```

---

## Opt-in: the access token itself

If the socket server accepts the API token and you can't add a ticket endpoint, enable `exposeTokens`:

```ts
export const api = createClient({ baseUrl: "https://api.example.com", exposeTokens: true });

const socket = io("https://realtime.example.com", {
  auth: async (cb) => cb({ token: await api.getAccessToken() }),
});
```

`getAccessToken()` refreshes first when the token is about to expire (within `refreshSkewMs`), so the handshake never gets a stale one. It resolves `undefined` when there is no usable token, and always in cookie mode, where the token is httpOnly and the browser sends the cookie on the handshake by itself.

> **The trade-off.** With `exposeTokens: true`, main-thread code — including an injected script — can read the token, which [[Web Worker Isolation]] otherwise prevents. Without the option, `getAccessToken()` rejects, and in worker mode the worker itself refuses, so page code can't talk it into handing the token over. Prefer the ticket when you can.

---

## Reconnecting after a refresh or logout

Tokens rotate. Reconnect when the session changes, so the server always holds a current credential and a logout closes the socket:

```ts
api.onAuthStateChange((state) => {
  if (!state.isAuthenticated) socket.disconnect();
  else if (socket.connected) socket.disconnect().connect(); // the auth function runs again
});
```

Next: **[[Security Model]]**
