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

/**
 * Subtypes that are text. Each name must be a whole token of the subtype
 * (`application/json`, `image/svg+xml`, `application/x-ndjson`): searching for
 * the bare letters also matched `application/vnd.openxmlformats-…` — every
 * xlsx, docx and pptx — and decoded those zip files as text.
 */
const TEXTUAL_TYPE =
  /^text\/|[/+.-](?:json|ndjson|jsonl|json5|xml|yaml|javascript|ecmascript|csv|graphql|urlencoded|event-stream)(?:[+-]|$)/;

/** Whether a `content-type` names a text format. Parameters (`charset`, `name`) are ignored. */
export function isTextualType(contentType: string): boolean {
  return TEXTUAL_TYPE.test((contentType.split(";")[0] ?? "").trim().toLowerCase());
}

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

  const type = response.headers.get("content-type") ?? "";
  // A binary format describes the file a success returns. A failed download
  // usually answers with a JSON or text error, which must stay readable so
  // `message`, `errors` and `ApiError.data` are filled in.
  const binary = format === "blob" || format === "arrayBuffer";
  if (binary && !response.ok && isTextualType(type)) format = "auto";

  if (format === "blob") return response.blob();
  if (format === "arrayBuffer") return response.arrayBuffer();
  if (format === "text") return response.text();
  if (format === "json") return parseJsonText(await response.text());

  if (type && !isTextualType(type)) {
    return typeof Blob !== "undefined" ? response.blob() : response.arrayBuffer();
  }
  return parseJsonText(await response.text());
}
