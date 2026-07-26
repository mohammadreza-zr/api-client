import type { APIConfig } from "../types";
import { applyUrlTemplate } from "../utils/url-template";
import { buildQueryString } from "../utils/query-string";
import { removeEmptyValues } from "../utils/helpers";

export interface BuiltUrl {
  fullUrl: string;
  queryString: string;
}

export function buildUrl(
  url: string,
  config: APIConfig | undefined,
  baseURL: string,
): BuiltUrl {
  let path = url;

  // 1. Append extra path segments → /url/seg1/seg2/
  if (config?.addToUrl?.length) {
    const hasFalsy = config.addToUrl.some((s) => !s && s !== 0);
    if (hasFalsy) {
      console.warn("[api-client] addToUrl contains a falsy value – skipping.", config.addToUrl);
      return { fullUrl: "", queryString: "" };
    }
    path = `${path.replace(/\/$/, "")}/${config.addToUrl.join("/")}/`;
  }

  // 2. Replace {placeholders}
  if (config?.addTemplateToUrl) {
    path = applyUrlTemplate(config.addTemplateToUrl, path);
  }

  // 3. Query string via qs
  const params = { ...(config?.params ?? {}) };
  removeEmptyValues(params);

  const queryString = Object.keys(params).length
    ? "?" + buildQueryString(params)
    : "";

  // 4. Combine
  const base = (config?.baseUrl ?? baseURL).replace(/\/+$/, "");
  const cleanPath = path.replace(/^\/+/, "");
  const fullUrl = `${base}/${cleanPath}${queryString}`;

  return { fullUrl, queryString };
}