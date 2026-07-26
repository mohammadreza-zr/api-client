import { describe, it, expect } from "vitest";
import { RequestQueue } from "../../src/core/request-queue";

describe("RequestQueue", () => {
  it("resolves all waiters with the same token", async () => {
    const q = new RequestQueue();

    const p1 = q.pause();
    const p2 = q.waitForResume();
    const p3 = q.waitForResume();

    expect(q.isPaused).toBe(true);

    q.resume("new-token");

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe("new-token");
    expect(r2).toBe("new-token");
    expect(r3).toBe("new-token");
    expect(q.isPaused).toBe(false);
  });

  it("resolves immediately if not paused", async () => {
    const q = new RequestQueue();
    const result = await q.waitForResume();
    expect(result).toBeNull();
  });

  it("handles failure (null)", async () => {
    const q = new RequestQueue();
    const p1 = q.pause();
    const p2 = q.waitForResume();

    q.resume(null);

    expect(await p1).toBeNull();
    expect(await p2).toBeNull();
  });

  it("can pause again after resume", async () => {
    const q = new RequestQueue();

    q.pause();
    q.resume("token-1");

    const p2 = q.pause();
    q.resume("token-2");

    expect(await p2).toBe("token-2");
  });
});