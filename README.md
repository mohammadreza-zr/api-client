# api-client

A typed, **concurrency-safe** API client with automatic token refresh,
request queuing, and Next.js server-side logging.

## Install

```bash
npm install @your-scope/api-client
# or
pnpm add @your-scope/api-client
```

## Quick Start

```typescript
// lib/api-client.ts
import { APIClient, CookieTokenStorage } from "@your-scope/api-client";
import { getCookie, setCookie, deleteCookie } from "cookies-next";

const storage = new CookieTokenStorage({
  getCookie,
  setCookie,
  deleteCookie,
  secure: process.env.NODE_ENV === "production",
});

export const apiService = new APIClient(
  {
    baseUrl: process.env.NEXT_PUBLIC_BASE_URL,
    refreshTokenUrl: "api/v1/auth/users/token/jwt/refresh/",
    onAuthFailure: () => {
      // redirect to login, clear state, etc.
      if (typeof window !== "undefined") window.location.pathname = "/login";
    },
  },
  storage,
  // refreshHandler – called when a 401 is received
  async (refreshToken) => {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_BASE_URL}/api/v1/auth/users/token/jwt/refresh/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh: refreshToken }),
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    await storage.setRefreshToken(data.refresh);
    return data.access;
  },
);
```

## Usage

```typescript
import { apiService } from "@/lib/api-client";

// GET
const res = await apiService.get<User>("/users/{id}", {
  addTemplateToUrl: { id: 42 },
});

// POST
const created = await apiService.post<User, CreateUserDto>("/users", {
  name: "John",
});

// With React Query
const { data } = useQuery({
  queryKey: ["user", id],
  queryFn: () => apiService.get<User>(`/users/${id}`),
});
```

## Concurrency-Safe Token Refresh

When **N** requests hit `401` simultaneously:

```
Request A ──→ 401 ──→ triggers refresh ──→ retry with new token ✓
Request B ──→ 401 ──→ waits ─────────────→ retry with new token ✓
Request C ──→ 401 ──→ waits ─────────────→ retry with new token ✓
```

Only **one** refresh call is made. All others await the same promise.

## Configuration

| Option | Env fallback | Default |
|---|---|---|
| `baseUrl` | `NEXT_PUBLIC_BASE_URL` | `""` |
| `timeout` | – | `30000` |
| `refreshTokenUrl` | `NEXT_PUBLIC_REFRESH_TOKEN_URL` | `api/v1/auth/users/token/jwt/refresh/` |
| `cookieSecure` | – | `true` in prod |

## License

MIT

```
                    ┌──────────────────────────────────────────────┐
                    │              TokenManager.refresh()          │
                    │                                              │
  Request A ─ 401 ─▶│  isPaused? NO                                │
                    │  → queue.pause()  ← creates shared Promise   │
                    │  → call refreshHandler() ──→ HTTP /refresh/  │
                    │  → queue.resume("new-token")                 │
                    └──────────────────────────────────────────────┘
                                    │
  Request B ─ 401 ──▶ isPaused? YES → queue.waitForResume() ──┐
  Request C ─ 401 ──▶ isPaused? YES → queue.waitForResume() ──┤
  Request D ─ 401 ──▶ isPaused? YES → queue.waitForResume() ──┤
                                                              │
                    All resolve with "new-token" ◀────────────┘
                    Each retries its original request once.