import type { ClientOptions, RequestConfig } from "../types";
import type { SerializableConfig, SerializableOptions } from "./protocol";

export function toSerializableOptions(options: ClientOptions, baseUrl: string): SerializableOptions {
  const {
    storage,
    extractTokens,
    buildRefreshBody,
    onAuthStateChanged: _a,
    onAuthFailure: _b,
    onError: _c,
    onLog: _d,
    worker: _e,
    // A function cannot be cloned; the worker asks the host for the token instead.
    getCsrfToken,
    // Cancellation is tracked on the host, which forwards `abort` messages.
    cancel: _g,
    // Plugins are functions and run on the host, around each call.
    plugins: _plugins,
    ...rest
  } = options;

  return {
    ...rest,
    // Function forms disable worker mode upstream, so only the declarative forms arrive here.
    extractTokens: typeof extractTokens === "function" ? undefined : extractTokens,
    buildRefreshBody: typeof buildRefreshBody === "function" ? undefined : buildRefreshBody,
    // A custom adapter object is served from the host; "local" just opts the worker into the storage bridge.
    storage: typeof storage === "object" ? "local" : storage,
    csrf: Boolean(getCsrfToken || options.xsrfCookieName),
    baseUrl,
  };
}

/** Splits a request config into what crosses the worker boundary and what stays on the host. */
export function splitConfig<R>(config?: RequestConfig<R>): {
  serializable?: SerializableConfig;
  beforeFunc?: (body: unknown) => unknown;
} {
  if (!config) return {};

  const {
    beforeFunc,
    // Response transforms are functions; the host applies them to the result.
    afterFunc: _afterFunc,
    beforeSelectOptions: _beforeSelectOptions,
    signal: _signal,
    // Cancellation metadata drives the host registry; the worker only needs the `abort` message.
    cancelable: _cancelable,
    cancelKey: _cancelKey,
    cancelGroup: _cancelGroup,
    takeLatest: _takeLatest,
    throwOnCancel: _throwOnCancel,
    ...rest
  } = config;

  return {
    serializable: rest as SerializableConfig,
    beforeFunc,
  };
}
