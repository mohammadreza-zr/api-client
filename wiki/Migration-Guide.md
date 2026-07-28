# Migration Guide

---

## From axios

### Instance → client

```ts
// axios
const client = axios.create({
  baseURL: "https://api.example.com",
  timeout: 30000,
  headers: { "X-App": "web" },
  withCredentials: true,
});

// api-client
const api = createClient({
  baseUrl: "https://api.example.com",
  timeout: 30_000,
  headers: { "X-App": "web" },
  credentials: "include",
});
```

### Requests

```ts
// axios
const { data } = await client.get("/users", { params: { page: 1 } });

// api-client
const { data } = await api.get<User[]>("/users", { params: { page: 1 } });
```

Both destructure `data`, but the surrounding envelope differs:

| axios | api-client |
|---|---|
| `res.data` — the raw body | `res.data` — the body, with `{ data }` unwrapped |
| `res.status` — a number | `res.statusCode` — a number; `res.status` is a **boolean** |
| `res.headers` | `res.headers` (lowercased keys) |
| `res.statusText` | `res.message` (from the body, not the status line) |

> The `status` rename is the most common migration bug. In axios `status === 200`; here `status === true`.

### Errors

```ts
// axios
catch (e) {
  if (axios.isAxiosError(e)) {
    e.response?.status;
    e.response?.data;
  }
}

// api-client
catch (e) {
  if (e instanceof ApiError) {
    e.statusCode;
    e.data;
    e.errors;   // field-level validation errors, extracted for you
  }
}
```

### Interceptors

There are no interceptors; the equivalents are options and hooks.

| axios | api-client |
|---|---|
| Request interceptor adding a token | Built in — `login()` / `setTokens()` |
| Request interceptor adding headers | `headers` option, or per-request `headers` |
| Request interceptor transforming the body | `beforeFunc` |
| Response interceptor transforming data | `afterFunc` |
| Response interceptor handling 401 + refresh | Built in — see [[Token Refresh]] |
| Response interceptor for global errors | `onError` |
| `transformRequest` / `transformResponse` | `beforeFunc` / `afterFunc` |

The classic axios refresh interceptor:

```ts
// axios — 40 lines of queue management, and a race condition if you get it wrong
client.interceptors.response.use(null, async (error) => {
  if (error.response?.status === 401 && !error.config._retry) {
    error.config._retry = true;
    const { data } = await axios.post("/auth/refresh", { refresh });
    localStorage.setItem("token", data.access);
    error.config.headers.Authorization = `Bearer ${data.access}`;
    return client(error.config);
  }
  return Promise.reject(error);
});
```

```ts
// api-client
const api = createClient({ baseUrl, refreshUrl: "/auth/refresh" });
```

### Cancellation

```ts
// axios
const source = axios.CancelToken.source();
client.get("/users", { cancelToken: source.token });
source.cancel();

// api-client — the standard AbortController
const controller = new AbortController();
api.get("/users", { signal: controller.signal });
controller.abort();

// …or the built-in registry, with no controller to carry around
const api = createClient({ baseUrl, cancel: true });
api.get("/users");
api.cancel("/users");        // by URL pattern, key or group
api.cancel();                // everything in flight
```

Closer to axios's `source.cancel()` for a group of requests: a scope.

```ts
const scope = api.cancelScope("users-page");
scope.get("/users");
scope.get("/users/roles");
scope.cancel();
```

See **[[Cancellation]]**.

### Query params

axios uses `paramsSerializer` for nested params. Here it's built in, and matches the `qs` bracket style by default.

```ts
// axios
client.get("/users", {
  params: { filter: { active: true } },
  paramsSerializer: (p) => qs.stringify(p, { arrayFormat: "repeat" }),
});

// api-client
api.get("/users", { params: { filter: { active: true } } });
// → /users?filter[active]=true
```

### Uploads

```ts
// axios
client.post("/upload", form, { headers: { "Content-Type": "multipart/form-data" } });

// api-client — the header is dropped so the runtime sets the boundary
api.post("/upload", form);
```

> Manually setting `multipart/form-data` without a boundary is a classic axios bug. This client removes such a header rather than let the request corrupt.

### `validateStatus`

```ts
// axios
client.get("/users", { validateStatus: () => true });

// api-client
api.get("/users", { throwError: false });
```

### Full mapping

| axios | api-client |
|---|---|
| `baseURL` | `baseUrl` |
| `withCredentials: true` | `credentials: "include"` (or `authMode: "cookie"`) |
| `xsrfCookieName` | `xsrfCookieName` (same name) |
| `xsrfHeaderName` | `xsrfHeaderName` (same name) |
| `paramsSerializer` | built in |
| `validateStatus` | `throwError` |
| `cancelToken` | `signal`, or the `cancel` option + `api.cancel()` |
| `source.cancel()` | `api.cancel(selector)` / `scope.cancel()` |
| `axios.isCancel(e)` | `e.canceled` |
| `responseType` | automatic (JSON, text, or undefined) |
| `maxRedirects` | `redirect` |
| `transformRequest` | `beforeFunc` |
| `transformResponse` | `afterFunc` |
| `isAxiosError(e)` | `e instanceof ApiError` |
| `e.response.status` | `e.statusCode` |
| `e.response.data` | `e.data` |

---

## From plain `fetch`

```ts
// before
async function getUsers() {
  const token = localStorage.getItem("token");
  const res = await fetch(`${BASE}/users?page=1`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (res.status === 401) {
    const t = await refreshToken();      // racy under concurrency
    return getUsers();                   // potentially infinite
  }
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).data;
}

// after
const { data } = await api.get<User[]>("/users", { params: { page: 1 } });
```

You also gain: refresh coalescing, timeouts, worker isolation, cross-tab sync, typed errors and nested param serialization.

---

## From an older envelope-style setup

`throwError` now defaults to `true`, so failed requests reject instead of resolving. Restore the old behaviour in one line:

```ts
export const api = createClient({ baseUrl: "…", throwError: false });
```

Everything else is unchanged.

### Adopting the new default

Replace `status` checks with `try/catch`:

```ts
// before
const res = await api.get("/users");
if (!res.status) return handle(res.message);
use(res.data);

// after
try {
  const { data } = await api.get("/users");
  use(data);
} catch (e) {
  handle((e as ApiError).message);
}
```

### Migrating incrementally

Flip the client default and opt individual call sites back out while you convert them:

```ts
export const api = createClient({ throwError: true });

// not yet converted
const res = await api.get("/legacy", { throwError: false });
if (!res.status) { /* old style */ }
```

Then remove the flags one file at a time. A quick sweep to find what needs attention:

```bash
rg 'await api\.\w+\([^)]*\)' -n src | rg -v 'try|catch' | head -50
rg '\.status\b' -n src   # boolean here, not a number
```

---

## From `react-query` + `axios`

Only the `queryFn` changes:

```ts
// before
queryFn: () => axios.get("/users").then((r) => r.data),

// after
queryFn: ({ signal }) => api.get<User[]>("/users", { signal }),
select: (res) => res.data,
```

Using `select` keeps the envelope out of your components while still letting you reach `statusCode` and `headers` in the query cache when you need them.

Retry logic gets simpler:

```ts
// before
retry: (n, e) => (axios.isAxiosError(e) && e.response?.status! < 500 ? false : n < 3),

// after
retry: (n, e) => (e instanceof ApiError && e.statusCode < 500 ? false : n < 3),
```

Next: **[[Troubleshooting]]**
