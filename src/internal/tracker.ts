import type { CancelSelector, ClientOptions, HttpMethod, PendingRequest, RequestConfig } from "../types";
import {
  CancelRegistry,
  groupsOf,
  isCancelable,
  previewUrl,
  resolveCancelDefaults,
  type CancelDefaults,
  type Tracked,
} from "./cancel";

/**
 * A client's cancellation state: which requests are tracked and how a
 * cancellation settles. Owned by whichever side holds the public client — the
 * page in worker mode — so `api.cancel()` stays synchronous.
 */
export class RequestTracker {
  private registry = new CancelRegistry();
  private defaults: CancelDefaults;

  constructor(
    option: ClientOptions["cancel"],
    private baseUrl: string,
  ) {
    this.defaults = resolveCancelDefaults(option);
  }

  /** Registers the request when it is cancelable; the caller releases it once settled. */
  track(method: HttpMethod, url: string, config?: RequestConfig<unknown>): Tracked | undefined {
    if (!isCancelable(method, config, this.defaults)) return undefined;
    return this.registry.track({
      method,
      url: previewUrl(url, this.baseUrl, config),
      key: config?.cancelKey,
      groups: groupsOf(config),
      takeLatest: config?.takeLatest ?? this.defaults.takeLatest,
    });
  }

  /** Cancels matching in-flight requests. Returns how many were stopped. */
  cancel(selector?: CancelSelector, reason?: string): number {
    return this.registry.cancel(selector, reason);
  }

  pending(selector?: CancelSelector): PendingRequest[] {
    return this.registry.pending(selector);
  }

  /** Whether a canceled request should reject. Independent of `throwError`. */
  shouldThrowOnCancel(config?: RequestConfig<unknown>): boolean {
    return config?.throwOnCancel ?? this.defaults.throwOnCancel;
  }
}
