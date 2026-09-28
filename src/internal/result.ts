import type { IRes, RequestConfig } from "../types";
import { cancelMessage, reasonOf } from "./cancel";

/** A result that has not reached the network yet. */
export function emptyResult<R>(): IRes<R> {
  return { statusCode: 0, status: false, message: "", data: undefined, loading: false };
}

/** A client-side failure: no HTTP response exists, so `statusCode` is `0`. */
export function failedResult<R>(message: string, error: unknown): IRes<R> {
  return { statusCode: 0, status: false, message, loading: false, error };
}

/** The message of a thrown value, whatever was thrown. */
export function errorMessage(error: unknown, fallback: string): string {
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" && message ? message : fallback;
}

/** Flags a result as a cancellation: something the app asked for, carrying its reason. */
export function markCanceled(result: IRes<unknown>, error: unknown): void {
  result.canceled = true;
  result.message = cancelMessage(error);
  const reason = reasonOf(error);
  if (reason) result.cancelReason = reason;
}

/**
 * Runs the caller's response transforms, on success only: they are written
 * for the success shape, and on an error body they would crash and hide the
 * real status. A transform that throws keeps the HTTP status.
 */
export function applyTransforms(
  result: IRes<unknown>,
  config: Pick<RequestConfig<unknown>, "beforeSelectOptions" | "afterFunc">,
): void {
  if (!result.status) return;
  try {
    let data = result.data;
    if (config.beforeSelectOptions) data = config.beforeSelectOptions(data);
    if (config.afterFunc) data = config.afterFunc(data);
    result.data = data;
  } catch (error) {
    result.status = false;
    result.error = error;
    result.message = errorMessage(error, "Response transform failed");
  }
}
