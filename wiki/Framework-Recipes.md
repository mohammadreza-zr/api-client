# Framework Recipes

The client is framework-agnostic. These are integration patterns, not requirements.

---

## TanStack Query (React Query)

Works out of the box — failures reject, which is exactly what the library expects. No per-call flags needed.

```tsx
// lib/api.ts
export const api = createClient({ baseUrl: import.meta.env.VITE_API_URL });

// features/users/queries.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@mrzr/api-client";
import { api } from "@/lib/api";

export const userKeys = {
  all: ["users"] as const,
  lists: () => [...userKeys.all, "list"] as const,
  list: (page: number) => [...userKeys.lists(), page] as const,
  detail: (id: number) => [...userKeys.all, "detail", id] as const,
};

export function useUsers(page = 1) {
  return useQuery({
    queryKey: userKeys.list(page),
    // `signal` wires react-query cancellation straight through to fetch
    queryFn: ({ signal }) => api.get<User[]>("/users", { params: { page }, signal }),
    select: (res) => res.data ?? [],
  });
}

export function useUser(id: number) {
  return useQuery({
    queryKey: userKeys.detail(id),
    queryFn: ({ signal }) =>
      api.get<User>("/users/{id}", { addTemplateToUrl: { id }, signal }),
    select: (res) => res.data,
    enabled: !!id,
    retry: (count, error) => {
      // Never retry client errors; ApiError carries the status code.
      if (error instanceof ApiError && error.statusCode < 500) return false;
      return count < 3;
    },
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUser) => api.post<User>("/users", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: userKeys.lists() }),
    onError: (e) => {
      if (e instanceof ApiError && e.statusCode === 422) setFieldErrors(e.errors ?? {});
    },
  });
}
```

### Global defaults

```tsx
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) =>
        error instanceof ApiError && error.statusCode < 500 ? false : count < 3,
      staleTime: 30_000,
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof ApiError && error.statusCode >= 500) {
        toast.error("Something went wrong on our end.");
      }
    },
  }),
});
```

### Clearing the cache on sign-out

```tsx
useEffect(() =>
  api.onAuthStateChange((s) => {
    if (!s.isAuthenticated) queryClient.clear();
  }), [queryClient]);
```

Essential with multi-tab sync: signing out in another tab must not leave user data in this tab's cache.

> ⚠️ Do **not** use `throwError: false` with React Query. A 500 would resolve successfully and be cached as data — no error state, no retry. The repo's verification suite documents this exact hazard.

---

## SWR

```ts
import useSWR from "swr";
import { ApiError } from "@mrzr/api-client";
import { api } from "@/lib/api";

const fetcher = <T,>(url: string) => api.get<T>(url).then((r) => r.data);

export function useUsers() {
  const { data, error, isLoading } = useSWR<User[], ApiError>("/users", fetcher);
  return { users: data ?? [], error, isLoading };
}
```

Because the client rejects on failure, `error` is a real `ApiError` and SWR's retry logic works as designed.

```tsx
<SWRConfig
  value={{
    fetcher,
    onErrorRetry: (error, _key, _cfg, revalidate, { retryCount }) => {
      if (error instanceof ApiError && error.statusCode < 500) return;
      if (retryCount >= 3) return;
      setTimeout(() => revalidate({ retryCount }), 1000 * 2 ** retryCount);
    },
  }}
>
  <App />
</SWRConfig>
```

---

## React without a data library

```tsx
import { useEffect, useState } from "react";
import { ApiError } from "@mrzr/api-client";

export function useApi<R>(fn: (signal: AbortSignal) => Promise<IRes<R>>, deps: unknown[] = []) {
  const [data, setData] = useState<R>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);

    fn(controller.signal)
      .then((res) => setData(res.data))
      .catch((e) => {
        if (e instanceof ApiError && e.statusCode === 0) return; // aborted
        setError(e as ApiError);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading };
}

// usage
const { data, error, loading } = useApi((signal) => api.get<User[]>("/users", { signal }));
```

---

## Next.js — App Router

### Server components and route handlers

```ts
// lib/server-api.ts
import { createClient } from "@mrzr/api-client";
import { cookies } from "next/headers";

export async function withApi<T>(fn: (api: ApiClient) => Promise<T>): Promise<T> {
  const api = createClient({
    baseUrl: process.env.API_URL,
    worker: false,    // no Worker on the server
    multiTab: false,  // keeps the event loop clean
  });

  const token = (await cookies()).get("access_token")?.value;
  if (token) await api.setTokens({ accessToken: token });

  try {
    return await fn(api);
  } finally {
    api.destroy();
  }
}
```

```tsx
// app/users/page.tsx
export default async function UsersPage() {
  const users = await withApi((api) =>
    api.get<User[]>("/users", { cache: "no-store" }).then((r) => r.data ?? []),
  );
  return <UserList users={users} />;
}
```

Next's fetch cache options pass straight through:

```ts
await api.get("/config", { cache: "force-cache" });
await api.get("/feed", { next: { revalidate: 60 } } as never);
```

### Client components

```ts
// lib/api.ts
"use client";
import { createClient } from "@mrzr/api-client";

export const api = createClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL,
  storage: "memory",
});
```

Import this only from client components. Server components should use the per-request factory above so tokens are never shared between users.

> **Never** create a module-level client with tokens on the server. Modules are shared across requests, so one user's token could leak into another user's response.

### Route handler proxy

Keep tokens entirely server-side by proxying:

```ts
// app/api/users/route.ts
import { NextResponse } from "next/server";
import { withApi } from "@/lib/server-api";

export async function GET() {
  const users = await withApi((api) => api.get<User[]>("/users").then((r) => r.data));
  return NextResponse.json(users);
}
```

The browser then calls `/api/users` with a same-site httpOnly cookie and never sees the upstream token.

---

## Nuxt 3

```ts
// plugins/api.ts
import { createClient } from "@mrzr/api-client";

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig();
  const api = createClient({
    baseUrl: config.public.apiUrl,
    worker: import.meta.client,
    multiTab: import.meta.client,
  });
  return { provide: { api } };
});
```

```vue
<script setup lang="ts">
const { $api } = useNuxtApp();

const { data: users, error } = await useAsyncData("users", () =>
  $api.get<User[]>("/users").then((r) => r.data ?? []),
);
</script>

<template>
  <div v-if="error">{{ error.message }}</div>
  <ul v-else><li v-for="u in users" :key="u.id">{{ u.name }}</li></ul>
</template>
```

---

## Vue 3 (plain)

```ts
// lib/api.ts
export const api = createClient({ baseUrl: import.meta.env.VITE_API_URL });
```

```vue
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ApiError } from "@mrzr/api-client";
import { api } from "@/lib/api";

const users = ref<User[]>([]);
const error = ref<string>();
const loading = ref(true);

onMounted(async () => {
  try {
    const { data } = await api.get<User[]>("/users");
    users.value = data ?? [];
  } catch (e) {
    error.value = (e as ApiError).message;
  } finally {
    loading.value = false;
  }
});
</script>
```

Prefer no try/catch in components? Create the client with `throwError: false` and branch on `res.status`.

---

## SvelteKit

```ts
// src/lib/api.ts
import { createClient } from "@mrzr/api-client";
import { browser } from "$app/environment";
import { PUBLIC_API_URL } from "$env/static/public";

export const api = createClient({
  baseUrl: PUBLIC_API_URL,
  worker: browser,
  multiTab: browser,
});
```

```ts
// +page.ts
export const load = async ({ fetch }) => ({
  users: (await api.get<User[]>("/users")).data ?? [],
});
```

```svelte
<script lang="ts">
  import { api } from "$lib/api";
  let promise = api.get<User[]>("/users");
</script>

{#await promise}
  <Spinner />
{:then res}
  <UserList users={res.data ?? []} />
{:catch error}
  <ErrorBox message={error.message} />
{/await}
```

---

## Angular

```ts
// api.service.ts
import { Injectable } from "@angular/core";
import { createClient, type ApiClient } from "@mrzr/api-client";
import { environment } from "../environments/environment";

@Injectable({ providedIn: "root" })
export class ApiService {
  readonly client: ApiClient = createClient({ baseUrl: environment.apiUrl });

  users() {
    return this.client.get<User[]>("/users").then((r) => r.data ?? []);
  }

  ngOnDestroy() { this.client.destroy(); }
}
```

Bridging to RxJS:

```ts
import { from, defer } from "rxjs";

users$ = defer(() => from(this.client.get<User[]>("/users"))).pipe(
  map((res) => res.data ?? []),
);
```

---

## Node / scripts / CLIs

```ts
import { createClient } from "@mrzr/api-client";

const api = createClient({
  baseUrl: process.env.API_URL,
  worker: false,
  multiTab: false,   // important: keeps the process from hanging
  timeout: 15_000,
});

try {
  await api.login({ email: process.env.EMAIL, password: process.env.PASSWORD });
  const { data } = await api.get<Report[]>("/reports");
  console.log(data);
} finally {
  api.destroy();
}
```

`multiTab` is auto-disabled on the server anyway (a ref'd `BroadcastChannel` would keep the event loop alive), but being explicit documents the intent.

---

## Cloudflare Workers / Deno / Bun

```ts
export default {
  async fetch(request: Request, env: Env) {
    const api = createClient({
      baseUrl: env.API_URL,
      worker: false,
      multiTab: false,
    });

    try {
      const { data } = await api.get("/health");
      return Response.json(data);
    } finally {
      api.destroy();
    }
  },
};
```

Create the client **inside** the handler, not at module scope — module state is shared across requests and isolates.

---

## Plain browser, no build step

```html
<script type="module">
  import { createClient } from "https://esm.sh/@mrzr/api-client";

  const api = createClient({ baseUrl: "https://api.example.com" });
  const { data } = await api.get("/health");
  document.body.textContent = JSON.stringify(data);
</script>
```

Next: **[[Cookbook]]**
