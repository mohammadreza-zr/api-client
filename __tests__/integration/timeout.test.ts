import { describe, it, expect, beforeEach } from "vitest";
import { APIClient } from "../../src/client";
import { MemoryTokenStorage } from "../../src/storage/memory-storage";
import { setTokens, resetRefreshCallCount } from "../mocks/handlers";

describe("Timeout", () => {
  beforeEach(async () => {
    resetRefreshCallCount();
    setTokens("valid-access", "valid-refresh");
  });

  it("aborts request after timeout", async () => {
    const storage = new MemoryTokenStorage();
    await storage.setAccessToken("valid-access");

    const api = new APIClient(
      { baseUrl: "https://api.test.com", timeout: 500 },
      storage,
    );

    const res = await api.get("/slow");

    expect(res.status).toBe(false);
    expect(res.message).toContain("abort");
  });

  it("succeeds within timeout", async () => {
    const storage = new MemoryTokenStorage();
    await storage.setAccessToken("valid-access");

    const api = new APIClient(
      { baseUrl: "https://api.test.com", timeout: 5000 },
      storage,
    );

    const res = await api.get("/users/");
    expect(res.status).toBe(true);
  });
});