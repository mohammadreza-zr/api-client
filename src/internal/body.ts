import type { ResponseFormat } from "../types";

/**
 * Body types that must be passed to fetch untouched.
 *
 * `ArrayBuffer.isView` is what catches `Uint8Array`, `DataView` and every other
 * typed-array view. Without it those objects fall through to `JSON.stringify`
 * and are silently transmitted as `{"0":72,"1":105}` instead of raw bytes.
 */
export function isRawBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return typeof body === "string";
  return isFormData(body) || isSelfDescribingBody(body);
}

export function isFormData(body: unknown): boolean {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

/**
 * A body that can only be sent once.
 *
 * A `ReadableStream` is consumed as it uploads, so it cannot be replayed on a
 * 401 retry — fetch rejects with "body object should not be disturbed or
 * locked". `Blob`, `FormData`, `ArrayBuffer` and strings are all re-readable.
 */
export function isSingleUseBody(body: unknown): boolean {
  return typeof ReadableStream !== "undefined" && body instanceof ReadableStream;
}

/**
 * Bodies that carry their own content type.
 *
 * Strings are excluded on purpose: a pre-serialized JSON string is a common
 * payload and must keep the `application/json` default.
 */
export function isSelfDescribingBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  return (
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) ||
    ArrayBuffer.isView(body) ||
    (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) ||
    isSingleUseBody(body)
  );
}

/** Reads a header case-insensitively. */
export function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key];
  }
  return undefined;
}

/** Removes a header regardless of the casing it was written with. */
export function deleteHeader(headers: Record<string, string>, name: string): void {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) delete headers[key];
  }
}

export function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

const TEXTUAL_TYPE = /json|^text\/|xml|javascript|x-www-form-urlencoded|csv|yaml|graphql|event-stream/i;

function parseJsonText(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Some servers mislabel plain text as JSON, or send JSON without the header.
    return text;
  }
}

/**
 * Reads the response body in the requested format.
 *
 * `"auto"` keeps binary payloads (files, images, PDFs) as a `Blob`: decoding
 * them as text replaces every invalid UTF-8 byte and corrupts the file.
 * Stream errors — including an abort or timeout while the body downloads —
 * propagate, so a truncated body is never reported as a success.
 */
export async function parseBody(response: Response, format: ResponseFormat = "auto"): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;

  if (format === "blob") return response.blob();
  if (format === "arrayBuffer") return response.arrayBuffer();
  if (format === "text") return response.text();
  if (format === "json") return parseJsonText(await response.text());

  const type = response.headers.get("content-type") ?? "";
  if (type && !TEXTUAL_TYPE.test(type)) {
    return typeof Blob !== "undefined" ? response.blob() : response.arrayBuffer();
  }
  return parseJsonText(await response.text());
}
