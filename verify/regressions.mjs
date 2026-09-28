/**
 * Regression suite for the security and correctness audit, main-thread mode.
 * Every case reproduces the original bug against a real HTTP server.
 */
import { createClient } from "../dist/index.js";
import { FILE_BYTES, jwt, seenAt, start, state } from "./regressions-server.mjs";

const BASE = "http://localhost:4620";
const FOREIGN = "http://127.0.0.1:4621";
let pass = 0,
  fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
};
const client = (options = {}) =>
  createClient({ baseUrl: BASE, worker: false, throwError: false, multiTab: false, ...options });
const within = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r("TIMED OUT"), ms))]);

const servers = [await start(4620), await start(4621)];

try {
  console.log("\ncredentials stay on trusted origins");
  const api = client({ xsrfCookieName: "csrftoken", getCsrfToken: () => "csrf-1" });
  await api.setTokens({ accessToken: jwt(600), refreshToken: "r" });
  await api.post(`${FOREIGN}/steal`, {});
  check("no bearer token to a foreign absolute URL", seenAt("/steal")[0]?.auth === null);
  check("no CSRF token to a foreign absolute URL", seenAt("/steal")[0]?.csrf === null);
  await api.get("/steal-override", { baseUrl: FOREIGN });
  check("no bearer token via a per-request baseUrl", seenAt("/steal-override")[0]?.auth === null);
  await api.post(`${BASE}/own`, {});
  check("bearer token still sent to the baseUrl origin", seenAt("/own")[0]?.auth?.startsWith("Bearer "));
  check("CSRF still sent to the baseUrl origin", seenAt("/own")[0]?.csrf === "csrf-1");
  const allowed = client({ authOrigins: [FOREIGN] });
  await allowed.setTokens({ accessToken: "tok", refreshToken: "r" });
  await allowed.get(`${FOREIGN}/allowed`);
  check("authOrigins opts an origin in", seenAt("/allowed")[0]?.auth === "Bearer tok");

  console.log("\nURL values are encoded");
  await api.get("/users/{id}", { addTemplateToUrl: { id: "1/../../admin?x=" } });
  check("template value cannot rewrite the path", seenAt("/users/")[0]?.path === "/users/1%2F..%2F..%2Fadmin%3Fx%3D");
  await api.get("/files", { addToUrl: ["a/b", "c?d"] });
  check("addToUrl segments are encoded", seenAt("/files")[0]?.path === "/files/a%2Fb/c%3Fd/");
  await api.get("/t/{a}/{b}", { addTemplateToUrl: { a: "{b}", b: "x" } });
  check("template substitution is single-pass", seenAt("/t/")[0]?.path === "/t/%7Bb%7D/x");

  console.log("\nrefresh flow");
  state.refreshMode = "hang";
  const hung = client({ timeout: 400 });
  await hung.setTokens({ accessToken: jwt(5), refreshToken: "r" });
  const t0 = Date.now();
  const outcome = await within(hung.get("/after-hang"), 3000);
  check("a hanging refresh endpoint cannot freeze requests", outcome !== "TIMED OUT", `${Date.now() - t0}ms`);
  check("a refresh timeout keeps the session", (await hung.getAuthState()).isAuthenticated === true);

  state.refreshMode = "slow";
  const racy = client();
  await racy.setTokens({ accessToken: "old", refreshToken: "r" });
  const inFlight = racy.refresh();
  await racy.logout();
  check("in-flight refresh reports failure after logout", (await inFlight) === false);
  check("logout is not undone by an in-flight refresh", (await racy.getAuthState()).isAuthenticated === false);

  state.refreshMode = "ok";
  state.refreshCsrf.length = 0;
  const csrfRefresh = client({ getCsrfToken: () => "csrf-refresh" });
  await csrfRefresh.setTokens({ accessToken: "a", refreshToken: "r" });
  await csrfRefresh.refresh();
  check("the refresh request carries the CSRF header", state.refreshCsrf[0] === "csrf-refresh");

  state.loginBody = { access: "B_ACCESS", user: { name: "B" } };
  state.refreshBodies.length = 0;
  const switcher = client();
  await switcher.setTokens({ accessToken: "A_ACCESS", refreshToken: "A_REFRESH" });
  await switcher.login({ user: "B" });
  await switcher.refresh();
  check("login drops the previous user's refresh token", !state.refreshBodies.some((b) => b.refresh === "A_REFRESH"));

  console.log("\nsession state");
  const expired = client();
  await expired.setTokens({ accessToken: jwt(-10), refreshToken: "valid" });
  check("expired access + refresh token is still authenticated", (await expired.getAuthState()).isAuthenticated === true);
  await expired.setTokens({ accessToken: jwt(600), refreshToken: "valid" });
  await expired.setTokens({ accessToken: undefined, refreshToken: undefined });
  check("setTokens with undefined values signs out", (await expired.getAuthState()).isAuthenticated === false);
  const opaque = client();
  await opaque.setTokens({ accessToken: jwt(-10), refreshToken: "r" });
  await opaque.setTokens({ accessToken: "opaque-token" });
  check("a new opaque token does not inherit the old expiry", (await opaque.getAuthState()).expiresAt === null);

  console.log("\ncookie mode");
  const cookie = client({ authMode: "cookie" });
  state.loginBody = { user: { name: "Ada" } };
  await cookie.login({});
  await cookie.get("/forbidden");
  check("403 does not sign the user out", (await cookie.getAuthState()).isAuthenticated === true);
  state.refreshMode = "down";
  await cookie.get("/private");
  check("a network blip during refresh keeps the session", (await cookie.getAuthState()).isAuthenticated === true);
  state.refreshMode = "ok";

  console.log("\nresponses");
  const notFound = await api.get("/missing", { afterFunc: (d) => d.items.map((x) => x) });
  check("afterFunc on an error response keeps the real status", notFound.statusCode === 404, String(notFound.statusCode));
  const broken = await api.get("/page", { afterFunc: () => null.x });
  check("a crashing transform keeps the HTTP status", broken.statusCode === 200 && broken.status === false);
  const file = await api.get("/file");
  const bytes = Buffer.from(await file.data.arrayBuffer());
  check("binary responses arrive byte-exact", bytes.equals(FILE_BYTES), `${bytes.length} bytes`);
  const buffer = await api.get("/file", { responseType: "arrayBuffer" });
  check("responseType arrayBuffer", Buffer.from(buffer.data).equals(FILE_BYTES));
  const text = await api.get("/page", { responseType: "text" });
  check("responseType text", typeof text.data === "string" && text.data.includes('"total":500'));
  const page = await api.get("/page");
  check("unwrapped data keeps its envelope in body", page.body?.meta?.total === 500 && page.data.length === 2);
  const stalled = await within(api.get("/stall-body", { timeout: 400 }), 3000);
  check("the timeout covers the body download", stalled.statusCode === 408, JSON.stringify(stalled.statusCode));

  console.log("\nContent-Type only with a body");
  await api.get("/ct-get");
  await api.delete("/ct-delete");
  await api.post("/ct-post", { a: 1 });
  check("GET sends no Content-Type (no CORS preflight)", seenAt("/ct-get")[0]?.ct === null);
  check("DELETE without body sends no Content-Type", seenAt("/ct-delete")[0]?.ct === null);
  check("JSON body still sends application/json", seenAt("/ct-post")[0]?.ct === "application/json");

  console.log("\ncross-tab");
  globalThis.window = globalThis;
  const tabA = client({ multiTab: true, storageKey: "tabs-memory" });
  const tabB = client({ multiTab: true, storageKey: "tabs-memory" });
  await tabA.setTokens({ accessToken: jwt(600), refreshToken: "r" });
  await tabB.get("/private");
  await new Promise((r) => setTimeout(r, 50));
  check("a tab without a session cannot log the others out", (await tabA.getAuthState()).isAuthenticated === true);

  if (typeof globalThis.navigator?.locks?.request === "function") {
    state.refreshMode = "rotate";
    state.liveRefresh.add("family-1");
    const shared = { value: null, get() { return this.value; }, set(t) { this.value = t; }, clear() { this.value = null; } };
    const tab1 = client({ multiTab: true, storage: shared, storageKey: "tabs-rotate" });
    const tab2 = client({ multiTab: true, storage: shared, storageKey: "tabs-rotate" });
    await tab1.setTokens({ accessToken: jwt(-10), refreshToken: "family-1" });
    await new Promise((r) => setTimeout(r, 50)); // let the "login" broadcast reach tab2
    const before = state.refreshCalls;
    const [one, two] = await Promise.all([tab1.refresh(), tab2.refresh()]);
    check("concurrent tabs spend a rotating refresh token once", !state.reuseDetected && state.refreshCalls - before === 1);
    check("both tabs end up signed in", one && two, `${one} ${two}`);
    [tab1, tab2].forEach((tab) => tab.destroy());
  } else {
    console.log("  - skipped: this runtime has no Web Locks API (navigator.locks)");
  }
  [tabA, tabB].forEach((tab) => tab.destroy());
} finally {
  servers.forEach((server) => server.close());
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
