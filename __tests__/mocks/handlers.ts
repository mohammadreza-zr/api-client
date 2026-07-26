import { http, HttpResponse } from "msw";

// ── Simulated state ──────────────────────────────────────
let validAccessToken = "initial-access-token";
let validRefreshToken = "initial-refresh-token";
let refreshCallCount = 0;

export function getRefreshCallCount() {
  return refreshCallCount;
}

export function resetRefreshCallCount() {
  refreshCallCount = 0;
}

export function expireAccessToken() {
  validAccessToken = "expired-" + Date.now();
}

export function setTokens(access: string, refresh: string) {
  validAccessToken = access;
  validRefreshToken = refresh;
}

// ── Helper: extract token from request ───────────────────
function getToken(request: Request): string {
  const authHeader = request.headers.get("authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/access_token=([^;]+)/);
  return match?.[1] ?? "";
}

function isAuthorized(request: Request): boolean {
  return getToken(request) === validAccessToken;
}

// ── Handlers ─────────────────────────────────────────────
export const handlers = [
  // ── Refresh Token ──
  http.post("https://api.test.com/auth/refresh/", async ({ request }) => {
    refreshCallCount++;

    const body = (await request.json()) as { refresh?: string };
    const cookie = request.headers.get("cookie") ?? "";

    const refreshToken =
      body.refresh ?? cookie.match(/refresh_token=([^;]+)/)?.[1];

    if (refreshToken !== validRefreshToken) {
      return HttpResponse.json(
        { message: "Invalid refresh token" },
        { status: 401 },
      );
    }

    const newAccess = "access-" + Date.now();
    const newRefresh = "refresh-" + Date.now();
    validAccessToken = newAccess;
    validRefreshToken = newRefresh;

    return HttpResponse.json(
      { access: newAccess, refresh: newRefresh },
      { status: 200 },
    );
  }),

  // ── Logout ──
  http.post("https://api.test.com/auth/logout/", ({ request }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json({ message: "Unauthorized" }, { status: 401 });
    }
    validAccessToken = "";
    validRefreshToken = "";
    return HttpResponse.json({ message: "Logged out" }, { status: 200 });
  }),

  // ── GET /users/ ──
  http.get("https://api.test.com/users/", ({ request }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json({ message: "Token expired" }, { status: 401 });
    }

    const url = new URL(request.url);
    const page = url.searchParams.get("page") ?? "1";

    return HttpResponse.json({
      data: [
        { id: 1, name: "Alice", page: Number(page) },
        { id: 2, name: "Bob", page: Number(page) },
      ],
      message: "OK",
    });
  }),

  // ── GET /users/:id ──
  http.get("https://api.test.com/users/:id", ({ request, params }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json({ message: "Token expired" }, { status: 401 });
    }

    return HttpResponse.json({
      data: { id: Number(params.id), name: "Alice", email: "alice@test.com" },
      message: "OK",
    });
  }),

  // ── POST /users/ ──
  http.post("https://api.test.com/users/", async ({ request }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json({ message: "Token expired" }, { status: 401 });
    }

    const body = (await request.json()) as Record<string, unknown>;

    if (!body.name || !body.email) {
      return HttpResponse.json(
        {
          message: "Validation failed",
          errors: {
            name: body.name ? [] : ["This field is required."],
            email: body.email ? [] : ["This field is required."],
          },
        },
        { status: 400 },
      );
    }

    return HttpResponse.json(
      { data: { id: 99, ...body }, message: "Created" },
      { status: 201 },
    );
  }),

  // ── PUT /users/:id ──
  http.put("https://api.test.com/users/:id", async ({ request, params }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json({ message: "Token expired" }, { status: 401 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: { id: Number(params.id), ...body },
      message: "Updated",
    });
  }),

  // ── PATCH /users/:id ──
  http.patch("https://api.test.com/users/:id", async ({ request, params }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json({ message: "Token expired" }, { status: 401 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: { id: Number(params.id), ...body },
      message: "Patched",
    });
  }),

  // ── DELETE /users/:id ──
  http.delete("https://api.test.com/users/:id", ({ request, params }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json({ message: "Token expired" }, { status: 401 });
    }

    return HttpResponse.json({
      message: "Deleted",
      data: { id: Number(params.id) },
    });
  }),

  // ── Public: GET /health ──
  http.get("https://api.test.com/health", () => {
    return HttpResponse.json({ status: "ok" });
  }),

  // ── Slow endpoint (timeout testing) ──
  http.get("https://api.test.com/slow", async () => {
    await new Promise((r) => setTimeout(r, 5000));
    return HttpResponse.json({ data: "slow response" });
  }),

  // ── Server error ──
  http.get("https://api.test.com/error", () => {
    return HttpResponse.json(
      { message: "Internal Server Error" },
      { status: 500 },
    );
  }),

  // ── Upload ──
  http.post("https://api.test.com/upload/", async ({ request }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json({ message: "Token expired" }, { status: 401 });
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return HttpResponse.json(
        { message: "Expected multipart/form-data" },
        { status: 400 },
      );
    }

    return HttpResponse.json({
      data: { url: "https://cdn.test.com/file.png" },
      message: "Uploaded",
    });
  }),
];