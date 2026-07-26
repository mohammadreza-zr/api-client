import qs from "qs";

/**
 * Replaces dot-notation with bracket notation.
 * `"wallet.balance"` → `"wallet[balance]"`
 */
export function replaceDotToBracket(name: string): string {
  const parts = name.split(".");
  if (parts.length <= 1) return name;
  const [head, ...rest] = parts;
  return head + rest.map((p) => `[${p}]`).join("");
}

/**
 * Serializes a params object into a URL query string using `qs`.
 *
 * - Nested objects → `wallet[balance]=0`
 * - Arrays         → `tokens[]=BTC&tokens[]=USDT`
 * - Nulls          → stripped
 * - Empty strings  → stripped
 */
export function buildQueryString(params: Record<string, unknown>): string {
  // qs has no "skipEmptyStrings" — filter them out before serializing
  const cleaned = stripEmpty(params);

  return qs.stringify(cleaned, {
    skipNulls: true,
    arrayFormat: "brackets",
    encodeValuesOnly: true,
    allowDots: true,
  });
}

/** Recursively removes null, undefined, and "" values. */
function stripEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined || value === "") continue;

    if (Array.isArray(value)) {
      result[key] = value.filter((v) => v !== null && v !== undefined && v !== "");
    } else if (typeof value === "object" && !(value instanceof Date)) {
      result[key] = stripEmpty(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}