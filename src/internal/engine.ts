import type { HttpMethod, IRes, LogEntry, RequestConfig } from "../types";
import {
  deleteHeader,
  findHeader,
  headersToObject,
  isFormData,
  isRawBody,
  isSelfDescribingBody,
  isSingleUseBody,
  parseBody,
} from "./body";
import { cancelMessage, linkSignals, reasonOf } from "./cancel";
import { assertFetchable } from "./env";
import { isTrustedUrl } from "./origin";
import { emptyResult, errorMessage } from "./result";
import { buildUrl } from "./url";

/** Everything the engine needs from its host (main thread or worker). */
export interface EngineContext {
  baseUrl: string;
  timeout: number;
  /** Client-wide headers. No implicit `Content-Type`: that depends on the body. */
  defaultHeaders: Record<string, string>;
  credentials: RequestCredentials;
  authMode: "header" | "cookie";
  /** Origins allowed to receive the access token and CSRF header. */
  trustedOrigins: ReadonlySet<string>;

  /** Current access token, or `undefined` in cookie mode. */
  getAccessToken(): string | undefined;

  /**
   * Runs the refresh flow. `true` when the session is usable again, `false`
   * when the refresh failed (network trouble or a rejected session).
   */
  refresh(): Promise<boolean>;

  /**
   * Proactive refresh check, run before the first attempt.
   * `skewMs` overrides the client-wide window (used by long uploads).
   */
  shouldPreemptivelyRefresh(skewMs?: number): boolean;

  /** Resolves the CSRF token to attach, or `undefined` when there is none. */
  getCsrfToken?(): Promise<string | undefined>;

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

/** One network attempt. `finish` must run once its body has been read. */
interface Attempt {
  response: Response;
  signal: AbortSignal;
  finish(): void;
}

/**
 * Whether the caller deliberately chose a Content-Type for this request.
 *
 * A per-request header is always deliberate. A client-wide `application/json`
 * is not — it is the generic default, so a binary body overrides it.
 */
function contentTypeWasSetBy(config: RequestConfig<unknown>, ctx: EngineContext): boolean {
  if (config.headers && findHeader(config.headers, "content-type") !== undefined) return true;
  const fromClient = findHeader(ctx.defaultHeaders, "content-type");
  return fromClient !== undefined && fromClient.toLowerCase() !== "application/json";
}

/** Serializes the body and settles `Content-Type` to match it. */
function encodeBody(
  body: unknown,
  headers: Record<string, string>,
  config: RequestConfig<unknown>,
  ctx: EngineContext,
): BodyInit | undefined {
  if (body === undefined || body === null) {
    // A body-less request with Content-Type forces a CORS preflight for nothing.
    if (!config.headers || findHeader(config.headers, "content-type") === undefined) {
      deleteHeader(headers, "content-type");
    }
    return undefined;
  }

  const raw = isRawBody(body) || config.isFormData || config.stringifyBody === false;
  if (config.isFormData === true || isFormData(body)) {
    // The runtime generates the multipart boundary; a hand-written type without one corrupts the request.
    const explicit = findHeader(headers, "content-type");
    if (!explicit || !explicit.includes("boundary=")) deleteHeader(headers, "content-type");
  } else if (raw && isSelfDescribingBody(body)) {
    // A Blob carries its `type`, URLSearchParams implies form-urlencoded.
    if (!contentTypeWasSetBy(config, ctx)) deleteHeader(headers, "content-type");
  } else if (findHeader(headers, "content-type") === undefined) {
    headers["Content-Type"] = "application/json";
  }
  return raw ? (body as BodyInit) : JSON.stringify(body);
}

async function buildHeaders(
  request: EngineRequest,
  config: RequestConfig<unknown>,
  ctx: EngineContext,
  trusted: boolean,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...ctx.defaultHeaders, ...config.headers };

  if (trusted && ctx.authMode === "header" && !config.skipAuth) {
    const token = ctx.getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    else delete headers.Authorization;
  }

  // Double-submit CSRF. The backend still compares the cookie with the header.
  const csrfHeader = ctx.csrfHeaderName;
  if (trusted && ctx.getCsrfToken && csrfHeader && UNSAFE_METHODS.has(request.method)) {
    if (findHeader(headers, csrfHeader) === undefined) {
      const csrf = await ctx.getCsrfToken();
      if (csrf) headers[csrfHeader] = csrf;
    }
  }
  return headers;
}

/**
 * Safari (WebKit bug 246069) rejects an in-flight abort with a bare
 * "AbortError" and drops the reason, so the error cannot tell a timeout from a
 * cancellation. The signal handed to fetch is authoritative.
 */
function normalizeAbort(signal: AbortSignal, error: unknown): unknown {
  const reason = signal.reason as { name?: string } | undefined;
  return reason?.name === "TimeoutError" ? new DOMException("Request timed out", "TimeoutError") : error;
}

async function sendAttempt(
  request: EngineRequest,
  finalUrl: string,
  body: unknown,
  ctx: EngineContext,
): Promise<Attempt> {
  const config = request.config ?? {};
  const trusted = isTrustedUrl(finalUrl, ctx.trustedOrigins);
  const headers = await buildHeaders(request, config, ctx, trusted);
  const init: RequestInit = {
    method: request.method,
    headers,
    body: encodeBody(body, headers, config, ctx),
    credentials: ctx.credentials,
  };

  // Required by spec when streaming a request body.
  if (isSingleUseBody(body)) {
    (init as RequestInit & { duplex?: string }).duplex = config.duplex ?? "half";
  }
  for (const key of PASSTHROUGH) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- whitelisted RequestInit keys copied verbatim
    if (config[key as keyof RequestConfig] !== undefined) (init as any)[key] = (config as any)[key];
  }

  // Every attempt gets a fresh timeout budget, covering the body download too.
  const timeoutMs = config.timeout ?? ctx.timeout;
  const timeoutController = new AbortController();
  const timer =
    timeoutMs > 0
      ? setTimeout(() => timeoutController.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs)
      : undefined;
  const { signal, release } = linkSignals([timeoutController.signal, config.signal, request.cancelSignal]);
  init.signal = signal;

  const finish = (): void => {
    if (timer) clearTimeout(timer);
    // Detach from the long-lived cancel signal, which would otherwise gain a listener per request.
    release();
  };

  try {
    return { response: await fetch(finalUrl, init), signal, finish };
  } catch (error) {
    finish();
    throw normalizeAbort(signal, error);
  }
}

/** Unwraps `{ data }` and runs the caller's transforms — on success only. */
function applyPayload(result: IRes<unknown>, parsed: unknown, config: RequestConfig<unknown>): void {
  const envelope = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  result.message = typeof envelope.message === "string" ? envelope.message : "";
  result.errors = (envelope.errors as Record<string, string[]>) ?? undefined;

  let data: unknown = parsed;
  if (!config.fullData && envelope.data !== undefined) {
    data = envelope.data;
    result.body = parsed;
  }
  result.data = data;
  // Transforms are written for the success shape; running them on an error body would crash and hide the status.
  if (!result.status) return;

  try {
    if (config.beforeSelectOptions) data = config.beforeSelectOptions(data as never);
    if (config.afterFunc) data = config.afterFunc(data as never);
    result.data = data;
  } catch (error) {
    result.status = false;
    result.error = error;
    result.message = errorMessage(error, "Response transform failed");
  }
}

/**
 * Executes one HTTP request with the full pipeline:
 * proactive refresh → fetch → 401 refresh + retry → parse → transform.
 *
 * Always resolves with an `IRes`; `throwError` is applied by the caller so
 * both the worker and main-thread paths get identical semantics.
 */
export async function executeRequest<R>(request: EngineRequest, ctx: EngineContext): Promise<IRes<R>> {
  const config = request.config ?? {};
  const started = Date.now();
  const result = emptyResult<R>();
  let finalUrl = "";

  try {
    finalUrl = buildUrl({
      url: request.url,
      baseUrl: config.baseUrl ?? ctx.baseUrl,
      addToUrl: config.addToUrl,
      addTemplateToUrl: config.addTemplateToUrl,
      params: config.params as Record<string, unknown> | undefined,
    });
    assertFetchable(finalUrl);

    const body = config.beforeFunc ? config.beforeFunc(request.body) : request.body;
    const wantsAuth = !config.skipAuth && config.refreshTokenCheck !== false;

    // `uploadSkewMs` widens the window for long uploads that would outlive the token.
    const skew = config.uploadSkewMs !== undefined && config.uploadSkewMs > 0 ? config.uploadSkewMs : undefined;
    if (wantsAuth && ctx.shouldPreemptivelyRefresh(skew)) await ctx.refresh();

    let attempt = await sendAttempt(request, finalUrl, body, ctx);
    try {
      if (attempt.response.status === 401 && wantsAuth && (await ctx.refresh())) {
        if (isSingleUseBody(body)) {
          result.statusCode = 401;
          result.message =
            "Access token expired during a streamed upload and the stream cannot be replayed. " +
            "The token has been refreshed — retry the upload, or pass `uploadSkewMs` to refresh before starting.";
          result.error = new Error("Stream body cannot be retried after 401");
          return settle(result, ctx, request, finalUrl, started);
        }
        attempt.finish();
        void attempt.response.body?.cancel().catch(() => {});
        attempt = await sendAttempt(request, finalUrl, body, ctx);
      }

      const { response } = attempt;
      result.statusCode = response.status;
      result.status = response.ok;
      result.headers = headersToObject(response.headers);

      let parsed: unknown;
      try {
        parsed = await parseBody(response, config.responseType);
      } catch (error) {
        throw normalizeAbort(attempt.signal, error);
      }
      applyPayload(result as IRes<unknown>, parsed, config);
      if (!response.ok && !result.message) result.message = `Request failed with status ${response.status}`;
    } finally {
      attempt.finish();
    }
  } catch (error) {
    applyFailure(result, error);
  }

  return settle(result, ctx, request, finalUrl, started);
}

function settle<R>(
  result: IRes<R>,
  ctx: EngineContext,
  request: EngineRequest,
  finalUrl: string,
  started: number,
): IRes<R> {
  if (request.config?.log) logResult(ctx, request, finalUrl, result, started);
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

/** Normalizes thrown errors (cancel, abort, timeout, offline, bad URL) into the envelope. */
function applyFailure(result: IRes<unknown>, error: unknown): void {
  const err = error as { name?: string; message?: string; cause?: { name?: string } } | undefined;
  result.status = false;
  result.error = error;
  result.statusCode = 0;

  // `cause` catches engines that expose the abort reason only through `error.cause`.
  if (err?.name === "TimeoutError" || err?.cause?.name === "TimeoutError") {
    result.statusCode = 408;
    result.message = "Request timed out";
    return;
  }
  if (err?.name === "AbortError") {
    // A cancel is something the app asked for, so it is flagged and carries the reason.
    result.canceled = true;
    result.message = cancelMessage(error);
    const reason = reasonOf(error);
    if (reason) result.cancelReason = reason;
    return;
  }

  result.message = errorMessage(error, "Network request failed");
}
