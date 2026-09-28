import type { ApiClient } from "./client";
import type { ClientOptions, HttpMethod, IRes, RequestConfig } from "./types";
import { errorMessage, failedResult } from "./internal/result";

/** One call as plugins see it, before it is sent. */
export interface PluginRequest {
  method: HttpMethod;
  url: string;
  body?: unknown;
  config?: RequestConfig<unknown>;
}

/**
 * An optional add-on for the client. Every hook is optional.
 *
 * Plugins run on the page, around the request — never inside the worker —
 * so a plugin never sees the access token.
 *
 * ```ts
 * const traceIds: ApiPlugin = {
 *   name: "trace-ids",
 *   beforeRequest: (request) => ({
 *     ...request,
 *     config: { ...request.config, headers: { ...request.config?.headers, "X-Trace-Id": crypto.randomUUID() } },
 *   }),
 * };
 * createClient({ baseUrl, plugins: [traceIds] });
 * ```
 */
export interface ApiPlugin<Extension extends object = object> {
  /** Named in the errors a failing plugin produces. */
  name: string;
  /** Adjusts the client options once, before the client is created. */
  configure?(options: ClientOptions): ClientOptions;
  /** Rewrites a call to `get`/`post`/`put`/`patch`/`delete` before it is sent. */
  beforeRequest?(request: PluginRequest): PluginRequest;
  /** Inspects or reshapes a call's result, before `throwError` applies. */
  afterResponse?(result: IRes<unknown>, request: PluginRequest): IRes<unknown>;
  /** Adds methods to the client. They may not replace built-in ones. */
  extend?(client: ApiClient): Extension;
}

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
  ? I
  : never;
type ExtensionOf<P> = P extends ApiPlugin<infer E> ? E : never;

/** The methods a list of plugins adds to the client. */
export type PluginExtensions<P extends readonly ApiPlugin[]> = UnionToIntersection<ExtensionOf<P[number]>>;

/** Folds every plugin's `configure` over the options. A plugin that fails here is a setup error. */
export function configureWith(plugins: readonly ApiPlugin[], options: ClientOptions): ClientOptions {
  return plugins.reduce((current, plugin) => {
    if (!plugin.configure) return current;
    try {
      return plugin.configure(current) ?? current;
    } catch (error) {
      throw new Error(`Plugin "${plugin.name}" failed in configure: ${errorMessage(error, "unknown error")}`);
    }
  }, options);
}

/**
 * Runs one call through the plugins. A plugin that throws fails only this
 * call, with a message naming it — never the client.
 */
export async function sendThrough(
  plugins: readonly ApiPlugin[],
  request: PluginRequest,
  send: (request: PluginRequest) => Promise<IRes<unknown>>,
): Promise<IRes<unknown>> {
  let current = request;
  for (const plugin of plugins) {
    if (!plugin.beforeRequest) continue;
    try {
      current = plugin.beforeRequest(current) ?? current;
    } catch (error) {
      return failedResult(`Plugin "${plugin.name}" failed before the request: ${errorMessage(error, "unknown error")}`, error);
    }
  }

  let result = await send(current);
  for (const plugin of plugins) {
    if (!plugin.afterResponse) continue;
    try {
      result = plugin.afterResponse(result, current) ?? result;
    } catch (error) {
      const message = `Plugin "${plugin.name}" failed after the response: ${errorMessage(error, "unknown error")}`;
      result = { ...result, status: false, error, message };
    }
  }
  return result;
}

/** Adds each plugin's methods to the client, refusing to replace a built-in or another plugin's. */
export function extendWith(client: ApiClient, plugins: readonly ApiPlugin[]): void {
  for (const plugin of plugins) {
    const extension = plugin.extend?.(client);
    if (!extension) continue;
    for (const key of Object.keys(extension)) {
      if (key in client) throw new Error(`Plugin "${plugin.name}" cannot replace api.${key}`);
    }
    Object.assign(client, extension);
  }
}
