/**
 * Regression suite for the audit, through the real worker bundle and host
 * protocol: the same bugs as verify/regressions.mjs where worker mode differs,
 * plus the worker-only ones (boot fallback, destroy during boot, CSRF bridge).
 */
import "./worker-harness.mjs";
import { FILE_BYTES, jwt, seenAt, start, state } from "./regressions-server.mjs";

const BASE = "http://localhost:4622";
const FOREIGN = "http://127.0.0.1:4623";
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
const within = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r("TIMED OUT"), ms))]);

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

  const file = await api.get("/file");
  const bytes = Buffer.from(await file.data.arrayBuffer());
  check("binary responses cross the boundary byte-exact", bytes.equals(FILE_BYTES));

  const roles = client({ loginUrl: "/login-with-roles" });
  const login = await roles.login({});
  check("login strips tokens from the result", login.data?.access === undefined && login.data?.refresh === undefined);
  check("login keeps non-token fields named like tokens", Array.isArray(login.data?.user?.access));

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
  delete globalThis.location;

  [api, roles, blocked, relative].forEach((instance) => instance.destroy());
} finally {
  servers.forEach((server) => server.close());
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
