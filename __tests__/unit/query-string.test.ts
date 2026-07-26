import { describe, it, expect } from "vitest";
import { buildQueryString } from "../../src/utils/query-string";

describe("buildQueryString (qs)", () => {
  it("serializes flat params", () => {
    const result = buildQueryString({ page: 1, limit: 20 });
    expect(result).toBe("page=1&limit=20");
  });

  it("serializes arrays with brackets", () => {
    const result = buildQueryString({ tags: ["a", "b"] });
    expect(result).toBe("tags[]=a&tags[]=b");
  });

  it("serializes nested objects with dots", () => {
    const result = buildQueryString({ filter: { status: "active" } });
    expect(result).toBe("filter.status=active");
  });

  it("strips null and undefined", () => {
    const result = buildQueryString({ a: 1, b: null, c: undefined });
    expect(result).toBe("a=1");
  });

  it("strips empty strings", () => {
    const result = buildQueryString({ a: 1, b: "" });
    expect(result).toBe("a=1");
  });

  it("handles deep nesting", () => {
    const result = buildQueryString({
      wallet: { balance: { min: 0 }, tokens: ["BTC"] },
    });
    expect(result).toContain("wallet.balance.min=0");
    expect(result).toContain("wallet.tokens[]=BTC");
  });

  it("handles Date objects", () => {
    const date = new Date("2026-01-15T00:00:00.000Z");
    const result = buildQueryString({ created: date });
    expect(result).toContain("created=");
    expect(result).toContain("2026");
  });
});