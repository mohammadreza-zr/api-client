/**
 * URL + query-string construction.
 *
 * Ported from the original `buildNestedQueryString` so serialization behaviour
 * is preserved, minus the `qs` dependency:
 *
 *   { name: "x", wallet: { balance: 0, tokens: ["BTC","USDT"] } }
 *   → name=x&wallet%5Bbalance%5D=0&wallet%5Btokens%5D=BTC&wallet%5Btokens%5D=USDT
 */

const ABSOLUTE_URL = /^[a-z][a-z\d+\-.]*:\/\//i;

/** `"wallet.balance"` → `"wallet[balance]"` */
export function replaceDotToBracket(name: string): string {
  const parts = name.split(".");
  if (parts.length <= 1) return name;
  const [head, ...rest] = parts;
  return head + rest.map((p) => `[${p}]`).join("");
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/**
 * Serializes params into a query string.
 * Nulls, undefineds and empty strings are dropped at every depth.
 */
export function buildQueryString(params: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(params ?? {})) {
    if (isEmpty(value)) continue;

    const path = prefix ? `${prefix}.${key}` : key;
    const encodedKey = encodeURIComponent(replaceDotToBracket(path));

    if (Array.isArray(value)) {
      for (const item of value) {
        if (isEmpty(item)) continue;
        if (item !== null && typeof item === "object") {
          const nested = buildQueryString(item as Record<string, unknown>, path);
          if (nested) parts.push(nested);
        } else {
          parts.push(`${encodedKey}=${encodeURIComponent(String(item))}`);
        }
      }
      continue;
    }

    if (value instanceof Date) {
      parts.push(`${encodedKey}=${encodeURIComponent(value.toISOString())}`);
      continue;
    }

    if (typeof value === "object") {
      const nested = buildQueryString(value as Record<string, unknown>, path);
      if (nested) parts.push(nested);
      continue;
    }

    parts.push(`${encodedKey}=${encodeURIComponent(String(value))}`);
  }

  return parts.join("&");
}

/** `/users/{id}` + `{ id: 7 }` → `/users/7` */
export function applyTemplate(url: string, template?: Record<string, string | number>): string {
  if (!template) return url;
  let result = url;
  for (const [key, value] of Object.entries(template)) {
    result = result.split(`{${key}}`).join(String(value));
  }
  return result;
}

/** Joins a base and a path without doubling or dropping slashes. */
export function joinUrl(base: string, path: string): string {
  if (!base) return path;
  if (ABSOLUTE_URL.test(path)) return path;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export interface BuildUrlInput {
  url: string;
  baseUrl: string;
  addToUrl?: (string | number)[];
  addTemplateToUrl?: Record<string, string | number>;
  params?: Record<string, unknown>;
}

/**
 * Builds the final request URL.
 * @throws {Error} when `addToUrl` contains a falsy segment — the original
 *         silently returned a fake 200, which hid real bugs.
 */
export function buildUrl(input: BuildUrlInput): string {
  let path = input.url;

  if (input.addToUrl?.length) {
    const bad = input.addToUrl.findIndex((s) => s !== 0 && !s);
    if (bad !== -1) {
      throw new Error(
        `addToUrl contains a falsy segment at index ${bad}: ${JSON.stringify(input.addToUrl)}`,
      );
    }
    path = `${path.replace(/\/$/, "")}/${input.addToUrl.join("/")}/`;
  }

  path = applyTemplate(path, input.addTemplateToUrl);

  const full = ABSOLUTE_URL.test(path) ? path : joinUrl(input.baseUrl, path);
  const query = input.params ? buildQueryString(input.params) : "";
  if (!query) return full;

  return full + (full.includes("?") ? "&" : "?") + query;
}
