# Plugins

Plugins are optional add-ons. The core stays small, and an app pays only for the plugins it imports: each one ships as its own entry point.

```ts
import { createClient } from "@mrzr/api-client";
import { services } from "@mrzr/api-client/services";

export const api = createClient({
  baseUrl: "https://api.example.com",
  plugins: [services({ files: "https://files.example.com" })],
});
```

---

## Built-in plugins

### `services` — several APIs, one session

Name your other APIs once; every service shares the client's login, token refresh, cancellation and plugins.

```ts
import { services } from "@mrzr/api-client/services";

const api = createClient({
  baseUrl: "https://api.example.com",           // the default service
  plugins: [
    services({
      files: "https://files.example.com",       // short form
      search: { baseUrl: import.meta.env.VITE_SEARCH_URL, timeout: 5_000 },
      billing: { baseUrl: "https://billing.example.com", headers: { "X-Tenant": "acme" } },
      maps: { baseUrl: "https://maps.thirdparty.com", auth: false },
    }),
  ],
});

await api.service("files").get("/uploads");
await api.service("billing").post("/invoices", invoice);
api.service("fiels");   // compile error: not a declared service
```

| Option | Default | Meaning |
|---|---|---|
| `baseUrl` | required | Where the service lives. An unset env variable fails at setup, naming the service |
| `auth` | `true` | Send the access token and refresh on 401. `false` for a third-party API: it never gets the token, and on its own origin no CSRF header either |
| `timeout` | client `timeout` | Default for this service's calls |
| `headers` | – | Merged under each call's own headers |

Services with `auth` are added to [`authOrigins`](Client-Options) for you. A call's own options still apply: `api.service("files").get("/x", { timeout: 60_000 })`.

Environment variables are not detected per service: bundlers only replace env names written literally in code, so pass them in as above.

If two services need *different* logins, create separate clients instead (see [[Client Options]] → *Multiple APIs in one app*).

---

## Writing a plugin

A plugin is an object with a `name` and any of four hooks:

```ts
import type { ApiPlugin } from "@mrzr/api-client";

export const traceIds: ApiPlugin = {
  name: "trace-ids",
  beforeRequest: (request) => ({
    ...request,
    config: {
      ...request.config,
      headers: { ...request.config?.headers, "X-Trace-Id": crypto.randomUUID() },
    },
  }),
};
```

| Hook | When | Use it to |
|---|---|---|
| `configure(options)` | Once, before the client exists | Add defaults, headers, trusted origins |
| `beforeRequest(request)` | Before each `get`/`post`/`put`/`patch`/`delete` | Rewrite `method`, `url`, `body` or `config` |
| `afterResponse(result, request)` | After each of those calls, before `throwError` | Reshape results, collect metrics, turn a failure into a fallback |
| `extend(client)` | Once, after the client exists | Add typed methods, like `api.service()` |

Plugins run in the order given. `login`, `logout` and the auth methods don't pass through `beforeRequest` / `afterResponse`; they stay under the client's control.

To add typed methods, give `ApiPlugin` the shape of what `extend` returns:

```ts
const health: ApiPlugin<{ health(): Promise<boolean> }> = {
  name: "health",
  extend: (client) => ({
    health: async () => (await client.get("/health", { throwError: false })).status,
  }),
};

const api = createClient({ baseUrl, plugins: [health] });
await api.health();   // typed
```

### Rules the client enforces

- **A failing plugin fails one call, never the client.** A hook that throws resolves that call as a failure whose message names the plugin; the next call runs normally. A plugin that throws in `configure` is a setup error and throws from `createClient`.
- **Plugins can't replace built-in methods.** `extend` returning `get`, `login` or another plugin's method throws at setup.
- **Plugins never see tokens.** They run on the page, around the request; in worker mode the token stays inside the worker.

### Security

Plugins are code your app chose to install, so they can do what your app can: a plugin's `configure` may add trusted origins, and its hooks see every request and response. Install plugins you trust, as you would any dependency. What a plugin can't do is read the access token — the same guarantee page code has.

Next: **[[Security Model]]**
