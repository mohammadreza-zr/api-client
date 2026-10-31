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
 * An object literal (or `Object.create(null)`), as opposed to a Blob, Date, Map or class instance.
 * Compares against the end of the prototype chain, not `Object.prototype`, so a literal
 * built in another realm (the worker's, an iframe's) still counts.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/**
 * `Object.prototype.toString` tag. `instanceof` fails for a value created in
 * another realm, and a structured clone from the page arrives as one in the worker.
 */
function tagOf(value: unknown): string {
  return Object.prototype.toString.call(value).slice(8, -1);
}

const isBlobLike = (value: unknown): value is Blob => {
  const tag = tagOf(value);
  return tag === "Blob" || tag === "File";
};

const isBinary = (value: unknown): boolean =>
  tagOf(value) === "ArrayBuffer" || tagOf(value) === "SharedArrayBuffer" || ArrayBuffer.isView(value);

/** Values JSON.stringify skips for an object property, so a form field skips them too. */
const isSkipped = (value: unknown): boolean =>
  value === undefined || value === null || typeof value === "function" || typeof value === "symbol";

/**
 * Serializes a nested value into a text field.
 *
 * A file or bytes inside it would be written as `{}` or `{"0":72}` and the
 * upload would silently lose them, so those throw and name the field instead.
 */
function toJsonField(key: string, value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "object" && v !== null) {
        if (isBlobLike(v) || isBinary(v) || tagOf(v) === "ReadableStream") {
          throw new TypeError("a file, bytes or stream cannot be nested inside an object");
        }
        if (tagOf(v) === "Map") return Object.fromEntries(v as Map<string, unknown>);
        if (tagOf(v) === "Set") return Array.from(v as Set<unknown>);
      }
      return v;
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeError(
      `isFormData: field "${key}" cannot be sent as text (${reason}). ` +
        "Put files and bytes at the top level of the body or inside a top-level array.",
    );
  }
}

function appendField(form: FormData, key: string, value: unknown): void {
  if (isSkipped(value)) return;
  if (isBlobLike(value)) {
    form.append(key, value);
  } else if (isBinary(value)) {
    // JSON.stringify would turn the bytes into {"0":72,"1":105}.
    form.append(key, new Blob([value as BlobPart]));
  } else if (Array.isArray(value) || tagOf(value) === "Set" || tagOf(value) === "FileList") {
    // One entry per item under the same key, the form most multipart parsers read as a list.
    for (const item of Array.from(value as ArrayLike<unknown>)) appendField(form, key, item);
  } else if (tagOf(value) === "Date") {
    // Same as JSON, where an invalid date is `null`; toISOString would throw instead.
    const time = (value as Date).getTime();
    if (!Number.isNaN(time)) form.append(key, new Date(time).toISOString());
  } else if (tagOf(value) === "URLSearchParams") {
    form.append(key, String(value));
  } else if (typeof value === "object") {
    // No bracket notation: its shape is server-specific. A nested object travels as a JSON string.
    form.append(key, toJsonField(key, value));
  } else {
    form.append(key, String(value));
  }
}

/**
 * Builds the `FormData` for `isFormData: true` when the body is a plain object.
 *
 * `File`/`Blob` and byte values, and arrays of them, are appended as files;
 * `null`, `undefined`, functions and symbols are skipped; anything else that is
 * not a string becomes text. Every other body (a real or polyfilled
 * `FormData`, a class instance, a string, bytes) is returned untouched.
 */
export function toFormData(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  if (typeof FormData === "undefined") {
    throw new TypeError("isFormData: this runtime has no FormData, so an object body cannot be converted.");
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) appendField(form, key, value);
  return form;
}

/**
 * A `FormData` as plain entries. A `FormData` itself cannot be structured-cloned
 * (`postMessage` throws a DataCloneError), but its strings and `File`s can.
 */
export type FormEntries = [name: string, value: string | Blob][];

export function formToEntries(form: FormData): FormEntries {
  return Array.from(form.entries());
}

export function entriesToForm(entries: FormEntries): FormData {
  const form = new FormData();
  for (const [name, value] of entries) form.append(name, value);
  return form;
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
