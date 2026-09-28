/**
 * Calls an app-supplied hook. A hook that throws is the app's bug, and must
 * never turn a settled request into a rejection or break the auth flow.
 */
export function callHook<A extends unknown[]>(hook: ((...args: A) => void) | undefined, ...args: A): void {
  try {
    hook?.(...args);
  } catch {
    /* the app's hook failed; the client carries on */
  }
}
