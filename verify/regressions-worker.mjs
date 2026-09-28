/**
 * Regression suite for the audit, through the real worker bundle and host
 * protocol: the same bugs as verify/regressions.mjs where worker mode differs,
 * plus the worker-only ones (boot fallback, destroy during boot, CSRF bridge).
 */
import "./worker-harness.mjs";
import { FILE_BYTES, jwt, seenAt, start, state } from "./regressions-server.mjs";
import { createChecker, within } from "./check.mjs";

const BASE = "http://localhost:4622";
const FOREIGN = "http://127.0.0.1:4623";
const { check, finish } = createChecker();

const servers = [await start(4622), await start(4623)];
const { createClient } = await import("../dist/index.js");
const client = (options = {}) => createClient({ baseUrl: BASE, throwError: false, multiTab: false, ...options });

try {
  console.log("\nworker mode");
  globalThis.document = { cookie: "csrftoken=from-host-cookie" };
  const api = client({ xsrfCookieName: "csrftoken" });
  check("runs in the worker", api.isWorker === true);
  await api.setTokens({ accessToken: jwt(600), refreshToken: "r" });

  await api.post(`${FOREIGN}/w-steal`, {});
  check("worker sends no bearer token to a foreign origin", seenAt("/w-steal")[0]?.auth === null);
  await api.post("/w-csrf", {});
  check("CSRF reaches the worker through the host bridge", seenAt("/w-csrf")[0]?.csrf === "from-host-cookie");

  state.refreshMode = "ok";
  state.refreshCsrf.length = 0;
  await api.refresh();
  check("the worker's refresh request carries CSRF", state.refreshCsrf[0] === "from-host-cookie");

  state.refreshMode = "reject";
  check("refresh() resolves false when the refresh is rejected", (await api.refresh()) === false);
  state.refreshMode = "ok";

  const thrown = await within(api.post("/w-x", {}, { beforeFunc: () => null.x }), 2000);
  check("a throwing beforeFunc resolves like main-thread mode", thrown?.status === false && thrown.statusCode === 0);
  const notFound = await api.get("/missing", { afterFunc: (d) => d.items.map((x) => x) });
  check("afterFunc on a 404 keeps the 404", notFound.statusCode === 404, String(notFound.statusCode));
  const broken = await api.get("/page", { afterFunc: () => null.x });
  check("a crashing transform keeps the HTTP status", broken.statusCode === 200 && broken.status === false, String(broken.statusCode));

  const file = await api.get("/file");
  const bytes = Buffer.from(await file.data.arrayBuffer());
  check("binary responses cross the boundary byte-exact", bytes.equals(FILE_BYTES));

  const roles = client({ loginUrl: "/login-with-roles" });
  const login = await roles.login({});
  check("login strips tokens from the result", login.data?.access === undefined && login.data?.refresh === undefined);
  check("login keeps non-token fields named like tokens", Array.isArray(login.data?.user?.access));

  console.log("\ntokens never cross to the page");
  // The rejected refresh above ended the session; these checks need a live one.
  await api.setTokens({ accessToken: jwt(600), refreshToken: "r" });
  const minted = await api.post("/auth/refresh", {});
  check(
    "a direct call to the refresh endpoint returns no token",
    minted.status && !minted.data?.access && !minted.data?.token && !minted.data?.refresh,
    JSON.stringify(minted.data),
  );
  const echoed = await api.get("/echo-auth");
  check("a response echoing the live token has it removed", echoed.status && echoed.data?.seen === undefined);
  const deep = await api.get("/echo-auth-deep");
  let innermost = deep.data;
  while (innermost?.level) innermost = innermost.level;
  check("a token nested 20 levels deep is removed too", deep.status && innermost && innermost.seen === undefined);
  const viaSocket = await api.getSocketToken("/auth/refresh").then(() => "LEAKED", () => "refused");
  check("getSocketToken cannot read a token from the refresh endpoint", viaSocket === "refused");

  console.log("\nboot failures");
  const RealWorker = globalThis.Worker;
  globalThis.Worker = class BlockedByCsp {
    constructor() {
      // Browsers report a CSP-blocked worker asynchronously, through onerror.
      setTimeout(() => this.onerror?.({ message: "Refused to create a worker (worker-src)" }), 0);
    }
    postMessage() {}
    terminate() {}
  };
  const blocked = client();
  globalThis.Worker = RealWorker;
  const viaFallback = await within(blocked.get("/w-fallback"), 3000);
  check("a CSP-blocked worker falls back to the page", viaFallback?.status === true, JSON.stringify(viaFallback?.message));
  check("isWorker reports the fallback", blocked.isWorker === false);

  const early = client();
  const pending = early.get("/w-early");
  early.destroy();
  const settled = await within(pending, 2000);
  check("destroy() during boot settles pending calls", settled !== "TIMED OUT" && settled.status === false);

  console.log("\nrelative baseUrl");
  globalThis.location = { href: `${BASE}/app/page`, origin: BASE, protocol: "http:" };
  const relative = createClient({ baseUrl: "/api", throwError: false, multiTab: false });
  const ping = await relative.get("/ping");
  check("a relative baseUrl works in worker mode", ping.status === true && seenAt("/api/ping").length === 1);
  const sameOrigin = createClient({ baseUrl: "", throwError: false, multiTab: false });
  const pong = await sameOrigin.get("/pong");
  check('baseUrl "" (the page origin) works in worker mode', pong.status === true, pong.message);
  sameOrigin.destroy();
  delete globalThis.location;

  [api, roles, blocked, relative].forEach((instance) => instance.destroy());
} finally {
  servers.forEach((server) => server.close());
  finish();
}
