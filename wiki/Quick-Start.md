# Quick Start

## 1. Create one client, export it

Create the client **once** per app and import it everywhere. Creating a client spins up a Web Worker and a BroadcastChannel, so you don't want one per component.

```ts
// lib/api.ts
import { createClient } from "@mohammadreza-zr/api-client";

export const api = createClient({
  baseUrl: "https://api.example.com",
});
```

If `baseUrl` is omitted, it is auto-detected from the first environment variable that is set: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_BASE_URL`, `VITE_API_URL`, `VITE_BASE_URL`, `NUXT_PUBLIC_API_URL`, `PUBLIC_API_URL`, `API_URL`.

Worker isolation, token refresh and cross-tab sync are **on by default** and disable themselves where unsupported.

---

## 2. Make a request

```ts
import { api } from "./lib/api";

interface User {
  id: number;
  name: string;
}

const { data, statusCode, headers } = await api.get<User[]>("/users");
//      ^? User[] | undefined
```

Every method resolves with the same envelope, [`IRes<R>`](Responses-and-Errors):

```ts
{
  statusCode: 200,
  status: true,
  message: "",
  data: [{ id: 1, name: "Ada" }],
  loading: false,
  headers: { "content-type": "application/json" }
}
```

---

## 3. Handle errors

**Failed requests reject with an `ApiError` by default.**

```ts
import { ApiError } from "@mohammadreza-zr/api-client";

try {
  const { data } = await api.get<User>("/users/1");
  render(data);
} catch (e) {
  if (e instanceof ApiError) {
    e.statusCode; // 404
    e.message;    // server message, or "Request failed with status 404"
    e.errors;     // { email: ["already taken"] }
    e.response;   // the full IRes envelope
  }
}
```

Prefer to never throw? One flag, globally or per call:

```ts
const api = createClient({ throwError: false });

const res = await api.get("/users");
if (!res.status) return showError(res.message);
use(res.data);
```

See **[[Responses and Errors]]** for the full story.

---

## 4. Log in

```ts
await api.login({ email: "a@b.com", password: "secret" });
// tokens are extracted from the response and stored internally —
// you never touch them

const me = await api.get<User>("/me"); // Authorization header attached

await api.logout(); // clears tokens in this tab and every other one
```

The default login endpoint is `POST /auth/login`. Change it with `loginUrl`. The default token extractor understands `{ access, refresh }`, `{ access_token, refresh_token }`, `{ accessToken, refreshToken }`, `{ token }`, `{ jwt }` and the same keys nested under `data`, `tokens`, `result` or `payload`.

---

## 5. React to auth state

```ts
const unsubscribe = api.onAuthStateChange(({ isAuthenticated, expiresAt, user }) => {
  if (!isAuthenticated) router.push("/login");
});

const state = await api.getAuthState(); // never contains tokens
```

---

## A complete example

```ts
// lib/api.ts
import { createClient, ApiError } from "@mohammadreza-zr/api-client";

export const api = createClient({
  baseUrl: import.meta.env.VITE_API_URL,
  storage: "memory",
  refreshSkewMs: 30_000,
  loginUrl: "/auth/login",
  refreshUrl: "/auth/refresh",
  onAuthFailure: () => {
    window.location.href = "/login";
  },
  onError: (res) => {
    if (res.statusCode >= 500) toast.error("Something went wrong on our end.");
  },
});

// features/users.ts
export async function listUsers(page = 1) {
  const { data } = await api.get<User[]>("/users", { params: { page } });
  return data ?? [];
}

export async function createUser(input: NewUser) {
  try {
    const { data } = await api.post<User>("/users", input);
    return data!;
  } catch (e) {
    if (e instanceof ApiError && e.statusCode === 422) {
      throw new ValidationError(e.errors ?? {});
    }
    throw e;
  }
}

export async function uploadAvatar(id: number, file: File) {
  const form = new FormData();
  form.append("avatar", file);

  return api.post(`/users/{id}/avatar`, form, {
    addTemplateToUrl: { id },
    timeout: 0,                  // don't abort a slow upload
    uploadSkewMs: 10 * 60_000,   // refresh the token first if it dies within 10 min
  });
}
```

---

## Where to go next

| You want to… | Read |
|---|---|
| Understand the envelope and execution modes | [[Core Concepts]] |
| Learn every request option | [[Request Config]] |
| Set up auth properly | [[Authentication]] |
| Upload files | [[Uploads and Binary Bodies]] |
| Wire it into React Query / SWR / Next.js | [[Framework Recipes]] |
| See every option in one table | [[Client Options]] |
