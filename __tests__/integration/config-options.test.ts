import { describe, it, expect, beforeEach } from "vitest";
import { APIClient } from "../../src/client";
import { MemoryTokenStorage } from "../../src/storage/memory-storage";
import { setTokens, resetRefreshCallCount } from "../mocks/handlers";

describe("Config Options", () => {
  let api: APIClient;

  beforeEach(async () => {
    resetRefreshCallCount();
    setTokens("valid-access", "valid-refresh");

    const storage = new MemoryTokenStorage();
    await storage.setAccessToken("valid-access");

    api = new APIClient({ baseUrl: "https://api.test.com" }, storage);
  });

  it("beforeFunc transforms body", async () => {
    const res = await api.post("/users/", { name: "test", email: "t@t.com" }, {
      beforeFunc: (body: any) => ({ ...body, name: body.name.toUpperCase() }),
    });
    expect(res.status).toBe(true);
    expect(res.data.name).toBe("TEST");
  });

  it("afterFunc transforms response", async () => {
    const res = await api.get("/users/", {
      afterFunc: (data: any) => data.map((u: any) => u.name),
    });
    expect(res.status).toBe(true);
    expect(res.data).toEqual(["Alice", "Bob"]);
  });

  it("fullData returns entire response", async () => {
    const res = await api.get("/users/", { fullData: true });
    expect(res.status).toBe(true);
    // fullData means we get { data: [...], message: "OK" } not just the array
    expect(res.data).toHaveProperty("data");
    expect(res.data).toHaveProperty("message");
  });

  it("addToUrl appends path segments", async () => {
    const res = await api.get("/users", { addToUrl: ["1"] });
    expect(res.status).toBe(true);
    expect(res.data.id).toBe(1);
  });

  it("skips request when addToUrl has falsy", async () => {
    const res = await api.get("/users", { addToUrl: [null as any] });
    // Should return default result without making a request
    expect(res.loading).toBe(false);
  });

  it("baseUrl override per-request", async () => {
    const res = await api.get("/health", {
      baseUrl: "https://api.test.com",
    });
    expect(res.status).toBe(true);
  });
});