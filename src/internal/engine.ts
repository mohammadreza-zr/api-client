import type { HttpMethod, IRes, LogEntry, RequestConfig } from "../types";
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

  /** Proactive refresh check, run before the first attempt. */
  shouldPreemptivelyRefresh(): boolean;

  onLog?(entry: LogEntry): void;
}

export interface EngineRequest {
  method: HttpMethod;
  url: string;
  body?: unknown;
  config?: RequestConfig<unknown>;
}

/** Body types that must be passed to fetch untouched. */
function isRawBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return typeof body === "string";
  return (
    (typeof FormData !== "undefined" && body instanceof FormData) ||
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) ||
    (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) ||
    (typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
  );
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

/** Combines the timeout signal with any caller-supplied signal. */
function linkSignals(
  timeoutSignal: AbortSignal,
  userSignal: AbortSignal | null | undefined,
): { signal: AbortSignal; dispose: () => void } {
  if (!userSignal) return { signal: timeoutSignal, dispose: () => {} };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyFn = (AbortSignal as any)?.any;
  if (typeof anyFn === "function") {
    return { signal: anyFn.call(AbortSignal, [timeoutSignal, userSignal]), dispose: () => {} };
  }

  // Fallback for runtimes without AbortSignal.any.
  const controller = new AbortController();
  const abort = (reason?: unknown) => controller.abort(reason);
  if (userSignal.aborted) abort(userSignal.reason);
  else if (timeoutSignal.aborted) abort(timeoutSignal.reason);
  else {
    userSignal.addEventListener("abort", () => abort(userSignal.reason), { once: true });
    timeoutSignal.addEventListener("abort", () => abort(timeoutSignal.reason), { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {},
  };
}

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

    // Refresh before we spend a round trip discovering the token is stale.
    const wantsAuth = !config.skipAuth && config.refreshTokenCheck !== false;
    if (wantsAuth && ctx.shouldPreemptivelyRefresh()) {
      await ctx.refresh();
    }

    const body = config.beforeFunc ? config.beforeFunc(request.body) : request.body;

    const send = async (): Promise<Response> => {
      const headers: Record<string, string> = { ...ctx.defaultHeaders, ...config.headers };

      if (ctx.authMode === "header" && !config.skipAuth) {
        const token = ctx.getAccessToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        else delete headers.Authorization;
      }

      let payload: BodyInit | undefined;
      if (body !== undefined && body !== null) {
        const raw = isRawBody(body) || config.isFormData || config.stringifyBody === false;
        payload = raw ? (body as BodyInit) : JSON.stringify(body);
        if (raw && (config.isFormData || (typeof FormData !== "undefined" && body instanceof FormData))) {
          // Let the runtime set the multipart boundary.
          delete headers["Content-Type"];
          delete headers["content-type"];
        }
      }

      const init: RequestInit = {
        method: request.method,
        headers,
        body: payload,
        credentials: ctx.credentials,
      };
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

      const { signal } = linkSignals(timeoutController.signal, config.signal);
      init.signal = signal;

      try {
        return await fetch(finalUrl, init);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    let response = await send();

    // 401 → refresh once → retry once.
    if (response.status === 401 && wantsAuth) {
      const token = await ctx.refresh();
      if (token !== null) {
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

  if (config.log) {
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

  return result;
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

/** Normalizes thrown errors (abort, timeout, offline, bad URL) into the envelope. */
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
    result.statusCode = 0;
    result.message = "Request aborted";
    return;
  }

  result.statusCode = 0;
  result.message = err?.message || "Network request failed";
}
