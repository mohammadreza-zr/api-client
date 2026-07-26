import { describe, it, expect, beforeEach } from "vitest";
import { APIClient } from "../../src/client";
import { MemoryTokenStorage } from "../../src/storage/memory-storage";
import { setTokens, expireAccessToken, resetRefreshCallCount } from "../mocks/handlers";

describe("Auth: Header Mode", () => {
  let storage: MemoryTokenStorage;
  let api: APIClient;

  beforeEach(async () => {
    resetRefreshCallCount();
    setTokens("valid-access", "valid-refresh");

    storage = new MemoryTokenStorage();
    await storage.setAccessToken("valid-access");
    await storage.setRefreshToken("valid-refresh");

    api = new APIClient(
      { baseUrl: "https://api.test.com", authMode: "header" },
      storage,
      async (refreshToken) => {
        const res = await fetch("https://api.test.com/auth/refresh/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh: refreshToken }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        await storage.setRefreshToken(data.refresh);
        return data.access;
      },
    );
  });

  it("sends Authorization header with valid token", async () => {
    const res = await api.get("/users/");
    expect(res.status).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.data).toHaveLength(2);
  });

  it("returns 401 result when token is expired and no refresh", async () => {
    expireAccessToken();

    const noRefreshApi = new APIClient(
      { baseUrl: "https://api.test.com" },
      storage,
      // no refresh handler
    );

    const res = await noRefreshApi.get("/users/", {
      refreshTokenCheck: false,
    });

    expect(res.status).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("refreshes token on 401 and retries", async () => {
    expireAccessToken();

    const res = await api.get("/users/");

    expect(res.status).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.data).toHaveLength(2);

    // Token in storage should be updated
    const newToken = await storage.getAccessToken();
    expect(newToken).not.toBe("valid-access");
    expect(newToken).toContain("access-");
  });

  it("calls onAuthFailure when refresh fails", async () => {
    expireAccessToken();
    await storage.setRefreshToken("wrong-refresh");

    let authFailed = false;

    const failApi = new APIClient(
      { baseUrl: "https://api.test.com" },
      storage,
      async (refreshToken) => {
        const res = await fetch("https://api.test.com/auth/refresh/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh: refreshToken }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.access;
      },
      () => {
        authFailed = true;
      },
    );

    const res = await failApi.get("/users/");

    expect(res.status).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(authFailed).toBe(true);
  });
});