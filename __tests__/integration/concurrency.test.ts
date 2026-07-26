import { describe, it, expect, beforeEach } from "vitest";
import { APIClient } from "../../src/client";
import { MemoryTokenStorage } from "../../src/storage/memory-storage";
import {
  setTokens,
  expireAccessToken,
  resetRefreshCallCount,
  getRefreshCallCount,
} from "../mocks/handlers";

describe("Concurrency: Multiple 401s", () => {
  let storage: MemoryTokenStorage;
  let api: APIClient;

  beforeEach(async () => {
    resetRefreshCallCount();
    setTokens("valid-access", "valid-refresh");

    storage = new MemoryTokenStorage();
    await storage.setAccessToken("valid-access");
    await storage.setRefreshToken("valid-refresh");

    api = new APIClient(
      { baseUrl: "https://api.test.com" },
      storage,
      async (refreshToken) => {
        // Simulate network delay
        await new Promise((r) => setTimeout(r, 100));

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

  it("fires only ONE refresh for 5 simultaneous 401s", async () => {
    expireAccessToken();

    // Fire 5 requests at the same time
    const results = await Promise.all([
      api.get("/users/"),
      api.get("/users/"),
      api.get("/users/"),
      api.get("/users/"),
      api.get("/users/"),
    ]);

    // All should succeed after refresh
    results.forEach((res) => {
      expect(res.status).toBe(true);
      expect(res.statusCode).toBe(200);
    });

    // Only ONE refresh call was made
    expect(getRefreshCallCount()).toBe(1);
  });

  it("all requests get the same new token", async () => {
    expireAccessToken();

    const results = await Promise.all([
      api.get("/users/"),
      api.get("/users/"),
      api.get("/users/"),
    ]);

    results.forEach((res) => {
      expect(res.status).toBe(true);
    });

    // Storage has the new token
    const token = await storage.getAccessToken();
    expect(token).toContain("access-");
    expect(getRefreshCallCount()).toBe(1);
  });

  it("handles refresh failure for all waiting requests", async () => {
    expireAccessToken();
    await storage.setRefreshToken("bad-token");

    let failCount = 0;

    const failApi = new APIClient(
      { baseUrl: "https://api.test.com" },
      storage,
      async (refreshToken) => {
        await new Promise((r) => setTimeout(r, 50));
        const res = await fetch("https://api.test.com/auth/refresh/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh: refreshToken }),
        });
        if (!res.ok) return null;
        return (await res.json()).access;
      },
      () => {
        failCount++;
      },
    );

    const results = await Promise.all([
      failApi.get("/users/"),
      failApi.get("/users/"),
      failApi.get("/users/"),
    ]);

    // All should fail
    results.forEach((res) => {
      expect(res.status).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    // onAuthFailure called only once
    expect(failCount).toBe(1);
    expect(getRefreshCallCount()).toBe(1);
  });
});