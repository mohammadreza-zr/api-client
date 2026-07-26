import type { APIConfig, IRes } from "../types";
import { isServer } from "../utils/helpers";

export interface ErrorInterceptorDeps {
  toast?: { error: (msg: string) => void };
}

/**
 * Decides whether to show a toast and whether to throw.
 */
export function handleError<R = any>(
  result: IRes<R>,
  config: APIConfig<any> | undefined,
  deps: ErrorInterceptorDeps,
): IRes<R> {
  const is401 = result.statusCode === 401;
  const suppressToast =
    config?.hideErrorMessage ||
    isServer() ||
    (config?.refreshTokenCheck !== false && is401);

  if (!suppressToast && deps.toast) {
    deps.toast.error(result.message || "Something went wrong");
  }

  if (result.statusCode >= 500 && config?.throwError) {
    throw new Error(result.message);
  }

  return result;
}