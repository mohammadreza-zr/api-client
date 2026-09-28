import type { ApiClient } from "../client";
import type { ApiPlugin } from "../plugin";
import type { RequestConfig } from "../types";

/** One service: where it lives, whether it gets the session, and its defaults. */
export interface ServiceOptions {
  baseUrl: string;
  /**
   * Send the access token to this service, and refresh it on 401. Default
   * `true`: declared services are yours. Set `false` for a third-party API:
   * it never gets the token, and on its own origin no CSRF header either.
   */
  auth?: boolean;
  /** Default timeout for this service's calls, in ms. */
  timeout?: number;
  /** Headers for this service's calls, merged under each call's own headers. */
  headers?: Record<string, string>;
}

/** A base URL, or the full options. */
export type ServiceDefinition = string | ServiceOptions;

/** A client bound to one service. Calls share the main client's session, refresh and plugins. */
export type ServiceClient = Pick<ApiClient, "get" | "post" | "put" | "patch" | "delete"> & {
  readonly name: string;
};

export interface ServicesExtension<Name extends string> {
  /** The client for one declared service. */
  service(name: Name): ServiceClient;
}

function normalize(definitions: Record<string, ServiceDefinition>): Map<string, ServiceOptions> {
  const services = new Map<string, ServiceOptions>();
  for (const [name, definition] of Object.entries(definitions)) {
    const options = typeof definition === "string" ? { baseUrl: definition } : definition;
    // An env variable that isn't set arrives as undefined; say which one instead of calling "undefined/users".
    if (!options?.baseUrl) throw new Error(`Service "${name}" has no baseUrl. Is its env variable set?`);
    services.set(name, options);
  }
  return services;
}

function bind(client: ApiClient, name: string, service: ServiceOptions): ServiceClient {
  const configure = <R>(config?: RequestConfig<R>): RequestConfig<R> => ({
    ...(service.timeout !== undefined ? { timeout: service.timeout } : {}),
    ...config,
    baseUrl: service.baseUrl,
    headers: { ...service.headers, ...config?.headers },
    ...(service.auth === false ? { skipAuth: true } : {}),
  });

  return {
    name,
    get: (url, config) => client.get(url, configure(config)),
    post: (url, body, config) => client.post(url, body, configure(config)),
    put: (url, body, config) => client.put(url, body, configure(config)),
    patch: (url, body, config) => client.patch(url, body, configure(config)),
    delete: (url, config) => client.delete(url, configure(config)),
  } as ServiceClient;
}

/**
 * Named services on one client, sharing one session:
 *
 * ```ts
 * import { services } from "@mrzr/api-client/services";
 *
 * const api = createClient({
 *   baseUrl: "https://api.example.com",
 *   plugins: [
 *     services({
 *       files: "https://files.example.com",
 *       maps: { baseUrl: "https://maps.thirdparty.com", auth: false },
 *     }),
 *   ],
 * });
 *
 * await api.service("files").get("/uploads");
 * ```
 *
 * Services with `auth` (the default) are added to `authOrigins`, so they
 * receive the token; `auth: false` services never do.
 */
export function services<const S extends Record<string, ServiceDefinition>>(
  definitions: S,
): ApiPlugin<ServicesExtension<Extract<keyof S, string>>> {
  const declared = normalize(definitions);
  const trusted = [...declared.values()].filter((s) => s.auth !== false).map((s) => s.baseUrl);

  return {
    name: "services",
    configure: (options) => ({ ...options, authOrigins: [...(options.authOrigins ?? []), ...trusted] }),
    extend: (client) => {
      const bound = new Map<string, ServiceClient>();
      return {
        service(name) {
          const service = declared.get(name);
          if (!service) throw new Error(`Unknown service "${name}". Declared: ${[...declared.keys()].join(", ")}`);
          let scoped = bound.get(name);
          if (!scoped) {
            scoped = bind(client, name, service);
            bound.set(name, scoped);
          }
          return scoped;
        },
      };
    },
  };
}
