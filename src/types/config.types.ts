import type { ListResponse, Ordering } from "./response.types";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface Params<T = unknown> {
  ordering?: T extends ListResponse<infer R> ? Ordering<R> : Ordering<T>;
  [key: string | number]: unknown;
}

/**
 * Per-request configuration.
 * Extends the native `RequestInit` so you can pass `signal`, `cache`, etc.
 */
export interface APIConfig<T = any> extends Omit<RequestInit, "body" | "method"> {
  /** Append path segments: `/url/${seg1}/${seg2}` */
  addToUrl?: (string | number)[];

  /** Replace `{key}` placeholders in the URL. */
  addTemplateToUrl?: Record<string, string | number>;

  /** Suppress the default toast on error. */
  hideErrorMessage?: boolean;

  /** Throw instead of returning an error result (useful for React Query). */
  throwError?: boolean;

  /** Query-string parameters (nested objects & arrays supported). */
  params?: Params<T>;

  /** Override the base URL for this single request. */
  baseUrl?: string;

  /** Return the full server payload instead of `data`. */
  fullData?: boolean;

  /** Enable the 401 → refresh → retry flow (default: true). */
  refreshTokenCheck?: boolean;

  /** JSON.stringify the body (default: true). Set false for FormData. */
  stringifyBody?: boolean;

  /** Mark body as FormData (removes Content-Type so the browser sets it). */
  isFormData?: boolean;

  /**
   * Write a server-side request log.
   * On the server it writes to `.next/api.log`; on the client it uses console.info.
   */
  log?: boolean;

  /** Transform the body before it is sent. */
  beforeFunc?: (body: any) => any;

  /** Transform the response data after it is received. */
  afterFunc?: (data: T) => any;

  /** Transform data specifically for select-option shapes. */
  beforeSelectOptions?: (data: T) => any;
}

/**
 * Internal shape passed to the request executor.
 *
 * Uses `APIConfig<any>` because type-safety is enforced at the public
 * API boundary (get<R>, post<R,B>, …). The internal pipeline just needs
 * to forward the config without re-checking the generic.
 */
export interface RequestProps<B = any> {
  method: HttpMethod;
  url: string;
  body?: B;
  config?: APIConfig<any>;
}