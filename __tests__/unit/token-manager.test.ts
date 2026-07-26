import { describe, it, expect, vi } from "vitest";
import { TokenManager } from "../../src/core/token-manager";
import { MemoryTokenStorage } from "../../src/storage/memory-storage";

describe("TokenManager", () => {
  it("calls refreshHandler only once for concurrent refreshes", async () => {
    const storage = new MemoryTokenStorage();
    await storage.setRefreshToken("old-refresh");

    const handler = vi.fn().mockResolvedValue("new-access");
    const tm = new TokenManager({ storage, refreshHandler: handler });

    const results = await Promise.all([
      tm.refresh(),
      tm.refresh(),
      tm.refresh(),
      tm.refresh(),
      tm.refresh(),
    ]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(results).toEqual(["new-access", "new-access", "new-access", "new-access", "new-access"]);
  });

  it("stores new token after refresh", async () => {
    const storage = new MemoryTokenStorage();
    await storage.setRefreshToken("r");

    const tm = new TokenManager({
      storage,
      refreshHandler: async () => "fresh-token",
    });

    await tm.refresh();
    expect(await storage.getAccessToken()).toBe("fresh-token");
  });

  it("calls onAuthFailure on null", async () => {
    const storage = new MemoryTokenStorage();
    await storage.setRefreshToken("bad");

    const onFail = vi.fn();
    const tm = new TokenManager({
      storage,
      refreshHandler: async () => null,
      onAuthFailure: onFail,
    });

    const result = await tm.refresh();
    expect(result).toBeNull();
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("clears tokens on failure", async () => {
    const storage = new MemoryTokenStorage();
    await storage.setAccessToken("a");
    await storage.setRefreshToken("r");

    const tm = new TokenManager({
      storage,
      refreshHandler: async () => null,
    });

    await tm.refresh();
    expect(await storage.getAccessToken()).toBeUndefined();
    expect(await storage.getRefreshToken()).toBeUndefined();
  });

  it("handles refreshHandler throwing", async () => {
    const storage = new MemoryTokenStorage();
    await storage.setRefreshToken("r");

    const onFail = vi.fn();
    const tm = new TokenManager({
      storage,
      refreshHandler: async () => { throw new Error("network"); },
      onAuthFailure: onFail,
    });

    const result = await tm.refresh();
    expect(result).toBeNull();
    expect(onFail).toHaveBeenCalled();
  });
});