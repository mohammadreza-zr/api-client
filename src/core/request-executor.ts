import type { APIConfig, IRes, RequestProps } from "../types";
import type { AuthMode } from "../config/defaults";
import { buildUrl } from "./url-builder";
import { logRequest } from "../logger/request-logger";
import { shallowClone } from "../utils/helpers";

export interface ExecutorDeps {
  baseURL: string;
  defaultHeaders: Record<string, string>;
  timeout: number;
  getAccessToken: () => Promise<string | undefined>;
  authMode: AuthMode;
  credentials: RequestCredentials;
}

export async function executeFetch<R = any>(
  props: RequestProps,
  deps: ExecutorDeps,
): Promise<{ result: IRes<R>; meta: Record<string, unknown> }> {
  const { method, url, body, config } = props;

  const result: IRes<R> = {
    loading: true,
    message: "",
    status: true,
    statusCode: 200,
    data: undefined as R,
  };

  const meta: Record<string, unknown> = {};
  const startTime = Date.now();

  const { fullUrl, queryString } = buildUrl(url, config, deps.baseURL);
  meta.url = fullUrl;
  meta.queryString = queryString;
  meta.method = method;

  if (!fullUrl) {
    result.loading = false;
    return { result, meta };
  }

  // ── headers ──────────────────────────────────────────────
  const headers: Record<string, string> = {
    ...deps.defaultHeaders,
    ...(config?.headers as Record<string, string> | undefined),
  };

  if (deps.authMode === "header") {
    const accessToken = await deps.getAccessToken();
    if (accessToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }
  }

  if (config?.isFormData) {
    delete headers["Content-Type"];
  }

  // ── body ─────────────────────────────────────────────────
  let processedBody: any = body;
  if (config?.beforeFunc) {
    processedBody = config.beforeFunc(body);
  }

  const fetchBody: RequestInit["body"] =
    processedBody != null
      ? config?.stringifyBody !== false
        ? JSON.stringify(processedBody)
        : (processedBody as BodyInit)
      : undefined;

  // ── fetch ────────────────────────────────────────────────
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeout);

  try {
    const response = await fetch(fullUrl, {
      ...shallowClone(config as Record<string, unknown>),
      method,
      headers,
      body: fetchBody,
      signal: controller.signal,
      credentials: deps.credentials,
    } as RequestInit);

    clearTimeout(timer);

    result.statusCode = response.status || 400;
    result.status = response.ok;
    meta.headers = response.headers;
    meta.redirected = response.redirected;

    // Always try to parse JSON (except 204 No Content)
    const data: any =
      response.status === 204
        ? undefined
        : await response.json().catch(() => undefined);

    result.errors = data?.errors;
    result.message = data?.message ?? "";

    let resultData: any = data ?? "";
    if (config?.beforeSelectOptions) {
      resultData = config.beforeSelectOptions(resultData);
    }
    if (!config?.fullData && data?.data !== undefined) {
      resultData = data.data;
    }
    if (config?.afterFunc) {
      resultData = config.afterFunc(resultData);
    }

    result.data = resultData as R;
    result.loading = false;

    if (!response.ok) {
      throw Object.assign(new Error(data?.message ?? "Request failed"), {
        statusCode: response.status,
        data,
      });
    }
  } catch (err: any) {
    clearTimeout(timer);

    const statusCode: number =
      err?.statusCode ?? err?.response?.status ?? 500;
    const message: string =
      err?.data?.message ?? err?.message ?? "Error from the Server!";

    result.statusCode = statusCode;
    result.status = false;
    result.message = message;
    result.loading = false;
    result.error = err;
    meta.error = err;
  }

  meta.duration = Date.now() - startTime;

  if (config?.log) {
    logRequest({
      url: fullUrl,
      method,
      statusCode: result.statusCode,
      status: result.status,
      message: result.message,
      queryString,
      duration: meta.duration as number,
      error: result.error,
    });
  }

  return { result, meta };
}