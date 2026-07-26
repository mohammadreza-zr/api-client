import { describe, it, expect, beforeEach, vi } from "vitest";
import { APIClient } from "../../src/client";
import { MemoryTokenStorage } from "../../src/storage/memory-storage";
import { setTokens, resetRefreshCallCount } from "../mocks/handlers";

describe("Error Handling", () => {
  let api: APIClient;
  let mockToast: { error: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    resetRefreshCallCount();
    setTokens("valid-access", "valid-refresh");

    const storage = new MemoryTokenStorage();
    await storage.setAccessToken("valid-access");

    mockToast = { error: vi.fn() };

    api = new APIClient(
      { baseUrl: "https://api.test.com", toast: mockToast },
      storage,
    );
  });

  it("captures 500 error without throwing", async () => {
    const res = await api.get("/error");
    expect(res.status).toBe(false);
    expect(res.statusCode).toBe(500);
    expect(res.message).toBe("Internal Server Error");
  });

  it("shows toast on error", async () => {
    await api.get("/error");
    expect(mockToast.error).toHaveBeenCalledWith("Internal Server Error");
  });

  it("suppresses toast with hideErrorMessage", async () => {
    await api.get("/error", { hideErrorMessage: true });
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("throws with throwError on 500", async () => {
    await expect(api.get("/error", { throwError: true })).rejects.toThrow(
      "Internal Server Error",
    );
  });

  it("captures validation errors", async () => {
    const res = await api.post("/users/", {});
    expect(res.status).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.errors?.name).toContain("This field is required.");
    expect(res.errors?.email).toContain("This field is required.");
  });
});