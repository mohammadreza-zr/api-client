import { describe, it, expect, beforeEach } from "vitest";
import { APIClient } from "../../src/client";
import { MemoryTokenStorage } from "../../src/storage/memory-storage";
import { setTokens, resetRefreshCallCount } from "../mocks/handlers";

describe("HTTP Methods", () => {
  let api: APIClient;

  beforeEach(async () => {
    resetRefreshCallCount();
    setTokens("valid-access", "valid-refresh");

    const storage = new MemoryTokenStorage();
    await storage.setAccessToken("valid-access");
    await storage.setRefreshToken("valid-refresh");

    api = new APIClient(
      { baseUrl: "https://api.test.com" },
      storage,
      async () => null,
    );
  });

  it("GET with query params", async () => {
    const res = await api.get("/users/", { params: { page: 2 } });
    expect(res.status).toBe(true);
    expect(res.data[0].page).toBe(2);
  });

  it("GET with URL template", async () => {
    const res = await api.get("/users/{id}", {
      addTemplateToUrl: { id: 42 },
    });
    expect(res.status).toBe(true);
    expect(res.data.id).toBe(42);
  });

  it("POST with body", async () => {
    const res = await api.post("/users/", {
      name: "Charlie",
      email: "charlie@test.com",
    });
    expect(res.status).toBe(true);
    expect(res.statusCode).toBe(201);
    expect(res.data.id).toBe(99);
    expect(res.data.name).toBe("Charlie");
  });

  it("POST validation error", async () => {
    const res = await api.post("/users/", { name: "" });
    expect(res.status).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.errors).toBeDefined();
    expect(res.errors?.email).toContain("This field is required.");
  });

  it("PUT", async () => {
    const res = await api.put(
      "/users/{id}",
      { name: "Updated" },
      { addTemplateToUrl: { id: 5 } },
    );
    expect(res.status).toBe(true);
    expect(res.data.id).toBe(5);
    expect(res.data.name).toBe("Updated");
  });

  it("PATCH", async () => {
    const res = await api.patch(
      "/users/{id}",
      { email: "new@test.com" },
      { addTemplateToUrl: { id: 7 } },
    );
    expect(res.status).toBe(true);
    expect(res.data.id).toBe(7);
    expect(res.data.email).toBe("new@test.com");
  });

  it("DELETE", async () => {
    const res = await api.delete("/users/{id}", {
      addTemplateToUrl: { id: 3 },
    });
    expect(res.status).toBe(true);
    expect(res.data.id).toBe(3);
  });
});