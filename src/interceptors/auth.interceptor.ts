import type { APIConfig, IRes, RequestProps } from "../types";
import type { TokenManager } from "../core/token-manager";
import { executeFetch, type ExecutorDeps } from "../core/request-executor";
import { isServer } from "../utils/helpers";

export async function handleAuth<R = any>(
  result: IRes<R>,
  props: RequestProps,
  config: APIConfig<any> | undefined,
  tokenManager: TokenManager,
  deps: ExecutorDeps,
): Promise<IRes<R>> {
  const shouldRefresh = config?.refreshTokenCheck !== false;
  if (result.statusCode !== 401 || !shouldRefresh) return result;

  // Only skip on server when using httpOnly cookies.
  // In cookie mode, the server can't call /refresh without the
  // original request's cookies (no access to them in a generic handler).
  //
  // In header mode, tokens live in JS memory → refresh works everywhere
  // (browser, Node scripts, Express servers, Next.js SSR with manual tokens).
  if (isServer() && deps.authMode === "cookie") {
    console.warn(`[api-client] 401 on server-side (cookie mode): ${props.url}`);
    return result;
  }

  // ── refresh (or wait for an in-flight refresh) ─────────
  const newToken = await tokenManager.refresh();

  if (newToken === null) {
    return result;
  }

  // ── retry the original request with the fresh token ────
  const { result: retryResult } = await executeFetch<R>(props, {
    ...deps,
    getAccessToken:
      deps.authMode === "header" && newToken
        ? async () => newToken
        : deps.getAccessToken,
  });

  return retryResult;
}