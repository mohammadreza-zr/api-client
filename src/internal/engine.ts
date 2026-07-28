import type { HttpMethod, IRes, LogEntry, RequestConfig } from "../types";
import { cancelMessage, linkSignals, reasonOf } from "./cancel";
import { buildUrl } from "./url";

/** Everything the engine needs from its host (main thread or worker). */
export interface EngineContext {
  baseUrl: string;
  timeout: number;
  defaultHeaders: Record<string, string>;
  credentials: RequestCredentials;
  authMode: "header" | "cookie";

  /** Current access token, or `undefined` in cookie mode. */
  getAccessToken(): string | undefined;

  /**
   * Runs the refresh flow. Returns the new access token, `""` when the server
   * only rotated httpOnly cookies, or `null` when refresh failed.
   */
  refresh(): Promise<string | null>;

  /**
   * Proactive refresh check, run before the first attempt.
   * `skewMs` overrides the client-wide window (used by long uploads).
   */
  shouldPreemptivelyRefresh(skewMs?: number): boolean;

  /**
   * Resolves the CSRF token to attach, when one is configured.
   * Returns `undefined` when there is nothing to send.
   */
  getCsrfToken?(): string | undefined;

  /** Header the CSRF token is sent under. */
  csrfHeaderName?: string;

  onLog?(entry: LogEntry): void;
}

/** Methods that mutate state, and therefore need CSRF protection. */
const UNSAFE_METHODS = new Set<HttpMethod>(["POST", "PUT", "PATCH", "DELETE"]);

export interface EngineRequest {
  method: HttpMethod;
  url: string;
  body?: unknown;
  config?: RequestConfig<unknown>;
  /**
   * Cancellation signal owned by the client's registry, merged with the
   * caller's `config.signal` and the per-attempt timeout.
   */
  cancelSignal?: AbortSignal;
}

/**
 * Body types that must be passed to fetch untouched.
 *
 * `ArrayBuffer.isView` is what catches `Uint8Array`, `DataView` and every other
 * typed-array view. Without it those objects fall through to `JSON.stringify`
 * and are silently transmitted as `{"0":72,"1":105}` instead of raw bytes.
 */
function isRawBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return typeof body === "string";
  return (
    (typeof FormData !== "undefined" && body instanceof FormData) ||
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) ||
    ArrayBuffer.isView(body) ||
    (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) ||
    (typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
  );
}

/**
 * A body that can only be sent once.
 *
 * A `ReadableStream` is consumed as it uploads, so it cannot be replayed on a
 * 401 retry — fetch rejects with "body object should not be disturbed or
 * locked". `Blob`, `FormData`, `ArrayBuffer` and strings are all re-readable
 * and retry safely.
 */
function isSingleUseBody(body: unknown): boolean {
  return typeof ReadableStream !== "undefined" && body instanceof ReadableStream;
}

/**
 * Bodies that carry their own content type.
 *
 * Strings are excluded on purpose: a pre-serialized JSON string is a common
 * payload and must keep the `application/json` default.
 */
function isSelfDescribingBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  return (
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) ||
    ArrayBuffer.isView(body) ||
    (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) ||
    (typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
  );
}

/**
 * Whether the caller deliberately chose a Content-Type for this request.
 *
 * A per-request header is always deliberate. A client-wide default is not: it
 * is the JSON fallback applied to every call, so a binary body should override
 * it rather than inherit it.
 */
function contentTypeWasSetBy(config: RequestConfig<unknown>, ctx: EngineContext): boolean {
  if (config.headers && findHeader(config.headers, "content-type") !== undefined) return true;
  const fromClient = findHeader(ctx.defaultHeaders, "content-type");
  // The built-in default is JSON; anything else was a conscious client choice.
  return fromClient !== undefined && fromClient.toLowerCase() !== "application/json";
}

/** Reads a header case-insensitively. */
function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key];
  }
  return undefined;
}

/** Removes a header regardless of the casing it was written with. */
function deleteHeader(headers: Record<string, string>, name: string): void {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) delete headers[key];
  }
}

/**
 * `RequestInit` keys we forward from user config.
 * A whitelist, so app-level options never leak into fetch and future spec
 * additions can't silently collide.
 */
const PASSTHROUGH: (keyof RequestInit)[] = [
  "cache",
  "integrity",
  "keepalive",
  "mode",
  "redirect",
  "referrer",
  "referrerPolicy",
  "window",
];

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Executes one HTTP request with the full pipeline:
 * proactive refresh → fetch → 401 refresh + retry → parse → transform.
 *
 * Always resolves with an `IRes`; `throwError` is applied by the caller so
 * both the worker and main-thread paths get identical semantics.
 */
export async function executeRequest<R>(
  request: EngineRequest,
  ctx: EngineContext,
): Promise<IRes<R>> {
  const config = request.config ?? {};
  const started = Date.now();

  const result: IRes<R> = {
    statusCode: 0,
    status: false,
    message: "",
    data: undefined,
    loading: false,
  };

  let finalUrl = "";

  try {
    finalUrl = buildUrl({
      url: request.url,
      baseUrl: config.baseUrl ?? ctx.baseUrl,
      addToUrl: config.addToUrl,
      addTemplateToUrl: config.addTemplateToUrl,
      params: config.params as Record<string, unknown> | undefined,
    });

    const body = config.beforeFunc ? config.beforeFunc(request.body) : request.body;

    // A stream is consumed while uploading, so it can never be replayed.
    const singleUse = isSingleUseBody(body);

    /*
     * Long uploads need a wider refresh window than ordinary requests.
     *
     * A token with 40s left passes the normal 30s check, but a 5-minute upload
     * will still be in flight when it expires — and the retry either re-uploads
     * the whole file or, for a stream, cannot happen at all. `uploadSkewMs`
     * lets the caller say "this request will take a while, so refresh now".
     */
    const uploadSkew = config.uploadSkewMs;
    const skew = uploadSkew !== undefined && uploadSkew > 0 ? uploadSkew : undefined;

    // Refresh before we spend a round trip discovering the token is stale.
    const wantsAuth = !config.skipAuth && config.refreshTokenCheck !== false;
    if (wantsAuth && ctx.shouldPreemptivelyRefresh(skew)) {
      await ctx.refresh();
    }

    const send = async (): Promise<Response> => {
      const headers: Record<string, string> = { ...ctx.defaultHeaders, ...config.headers };

      if (ctx.authMode === "header" && !config.skipAuth) {
        const token = ctx.getAccessToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        else delete headers.Authorization;
      }

      /*
       * CSRF: mirror the cookie your backend set into a header.
       *
       * Only for state-changing methods, and never overriding a header the
       * caller set explicitly. The backend still does the real work — it must
       * compare the two and reject mismatches — but this makes the standard
       * double-submit pattern a one-line client setup.
       */
      if (ctx.getCsrfToken && ctx.csrfHeaderName && UNSAFE_METHODS.has(request.method)) {
        if (findHeader(headers, ctx.csrfHeaderName) === undefined) {
          const csrf = ctx.getCsrfToken();
          if (csrf) headers[ctx.csrfHeaderName] = csrf;
        }
      }

      let payload: BodyInit | undefined;
      if (body !== undefined && body !== null) {
        const raw = isRawBody(body) || config.isFormData || config.stringifyBody === false;
        payload = raw ? (body as BodyInit) : JSON.stringify(body);

        const isFormData =
          config.isFormData === true || (typeof FormData !== "undefined" && body instanceof FormData);

        if (isFormData) {
          // The multipart boundary is generated by the runtime; any
          // hand-written Content-Type without one corrupts the request.
          const explicit = findHeader(headers, "content-type");
          if (!explicit || !explicit.includes("boundary=")) deleteHeader(headers, "content-type");
        } else if (raw && isSelfDescribingBody(body)) {
          // Binary and form-encoded bodies describe their own type (a Blob
          // carries `type`, URLSearchParams implies form-urlencoded). Sending
          // the inherited `application/json` default would mislabel them, so
          // drop it and let fetch decide — unless the caller was explicit.
          if (!contentTypeWasSetBy(config, ctx)) deleteHeader(headers, "content-type");
        }
      }

      const init: RequestInit = {
        method: request.method,
        headers,
        body: payload,
        credentials: ctx.credentials,
      };

      // Required by spec when streaming a request body; omitting it makes
      // fetch reject with "duplex option is required when sending a body".
      if (singleUse) {
        (init as RequestInit & { duplex?: string }).duplex = config.duplex ?? "half";
      }
      for (const key of PASSTHROUGH) {
        if (config[key as keyof RequestConfig] !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (init as any)[key] = (config as any)[key];
        }
      }

      // Every attempt gets a fresh timeout budget.
      const timeoutMs = config.timeout ?? ctx.timeout;
      const timeoutController = new AbortController();
      const timer =
        timeoutMs > 0
          ? setTimeout(() => timeoutController.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs)
          : undefined;

      // Timeout, the caller's own signal, and the cancel registry's — first
      // one to fire wins, and its `reason` is what reaches `applyFailure`.
      const { signal, release } = linkSignals([
        timeoutController.signal,
        config.signal,
        request.cancelSignal,
      ]);
      init.signal = signal;

      try {
        return await fetch(finalUrl, init);
      } finally {
        if (timer) clearTimeout(timer);
        // Detach from the long-lived cancel signal; a scope controller would
        // otherwise accumulate a listener for every request it ever covered.
        release();
      }
    };

    let response = await send();

    // 401 → refresh once → retry once.
    if (response.status === 401 && wantsAuth) {
      const token = await ctx.refresh();
      if (token !== null) {
        if (singleUse) {
          /*
           * The stream was consumed by the first attempt, so replaying it
           * would throw an opaque "body disturbed or locked" error from fetch.
           * Surface something the caller can act on instead: the token *is*
           * now fresh, so simply re-issuing the call will succeed.
           */
          result.statusCode = 401;
          result.status = false;
          result.message =
            "Access token expired during a streamed upload and the stream cannot be replayed. " +
            "The token has been refreshed — retry the upload, or pass `uploadSkewMs` to refresh before starting.";
          result.error = new Error("Stream body cannot be retried after 401");
          if (config.log) logResult(ctx, request, finalUrl, result, started);
          return result;
        }
        response = await send();
      }
    }

    result.statusCode = response.status;
    result.status = response.ok;
    result.headers = headersToObject(response.headers);

    const parsed = await parseBody(response);
    const envelope = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;

    result.message = typeof envelope.message === "string" ? envelope.message : "";
    result.errors = (envelope.errors as Record<string, string[]>) ?? undefined;

    let data: unknown = parsed;
    if (!config.fullData && envelope.data !== undefined) data = envelope.data;
    if (config.beforeSelectOptions) data = config.beforeSelectOptions(data as never);
    if (config.afterFunc) data = config.afterFunc(data as never);
    result.data = data as R;

    if (!response.ok && !result.message) {
      result.message = `Request failed with status ${response.status}`;
    }
  } catch (error) {
    applyFailure(result, error);
  }

  if (config.log) logResult(ctx, request, finalUrl, result, started);

  return result;
}

/** Emits a structured log entry for a settled request. */
function logResult(
  ctx: EngineContext,
  request: EngineRequest,
  finalUrl: string,
  result: IRes<unknown>,
  started: number,
): void {
  const entry: LogEntry = {
    url: finalUrl || request.url,
    method: request.method,
    statusCode: result.statusCode,
    status: result.status,
    message: result.message,
    durationMs: Date.now() - started,
    timestamp: new Date().toISOString(),
    error: result.error,
  };
  if (ctx.onLog) ctx.onLog(entry);
  else console.info("[api-client]", entry);
}

/** Parses the response body, tolerating empty and non-JSON payloads. */
async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;

  const type = response.headers.get("content-type") ?? "";
  try {
    if (type.includes("json")) return await response.json();

    const text = await response.text();
    if (!text) return undefined;
    // Some servers send JSON without the header.
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return undefined;
  }
}

/** Normalizes thrown errors (cancel, abort, timeout, offline, bad URL) into the envelope. */
function applyFailure(result: IRes<unknown>, error: unknown): void {
  const err = error as { name?: string; message?: string } | undefined;
  result.status = false;
  result.error = error;

  if (err?.name === "TimeoutError") {
    result.statusCode = 408;
    result.message = "Request timed out";
    return;
  }
  if (err?.name === "AbortError") {
    /*
     * Cancellation and abort are the same event to `fetch`, but not to the
     * caller: a cancel is something the app asked for, so it is flagged and
     * carries the reason. A timeout is neither — it keeps its own 408.
     */
    result.statusCode = 0;
    result.canceled = true;
    result.message = cancelMessage(error);
    const reason = reasonOf(error);
    if (reason) result.cancelReason = reason;
    return;
  }

  result.statusCode = 0;
  result.message = err?.message || "Network request failed";
}
