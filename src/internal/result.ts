import type { IRes } from "../types";

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
