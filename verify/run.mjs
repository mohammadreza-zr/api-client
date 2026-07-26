/** End-to-end verification against a real HTTP server. Not part of the package. */
import { start, state, expireAccess } from "./server.mjs";
import { createClient, ApiError, buildQueryString, getTokenExpiry } from "../dist/index.js";

const BASE = "http://localhost:4599";
let pass = 0,
  fail = 0;

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const { server } = await start(4599);

try {
  // ── query string ────────────────────────────────────────
  console.log("\nquery serialization");
  check(
    "nested + arrays match legacy format",
    buildQueryString({ name: "x", wallet: { balance: 0, tokens: ["BTC", "USDT"] } }) ===
      "name=x&wallet%5Bbalance%5D=0&wallet%5Btokens%5D=BTC&wallet%5Btokens%5D=USDT",
    buildQueryString({ name: "x", wallet: { balance: 0, tokens: ["BTC", "USDT"] } }),
  );
  check("empties dropped", buildQueryString({ a: 1, b: null, c: "", d: undefined }) === "a=1");

  // ── basics ──────────────────────────────────────────────
  console.log("\nrequests");
  const api = createClient({ baseUrl: BASE, worker: false, refreshSkewMs: 0 });
  check("runs main-thread on server", api.isWorker === false);

  const echo = await api.get("/echo", { params: { a: 1, nested: { b: 2 }, list: [1, 2] } });
  check("GET ok", echo.status && echo.statusCode === 200);
  check("nested params sent", echo.data.query === "?a=1&nested%5Bb%5D=2&list=1&list=2", echo.data.query);

  const posted = await api.post("/echo", { hello: "world" });
  check("POST body json", posted.data.body.hello === "world");

  const nc = await api.get("/nocontent");
  check("204 handled", nc.status && nc.data === undefined);

  const txt = await api.get("/text");
  check("text/plain handled", txt.data === "plain hello", JSON.stringify(txt.data));

  const unwrap = await api.get("/echo");
  check("unwraps {data}", unwrap.data.query !== undefined);
  const full = await api.get("/echo", { fullData: true });
  check("fullData keeps envelope", full.data.data !== undefined);

  // ── errors ──────────────────────────────────────────────
  console.log("\nerrors");
  let errSeen = null;
  const errApi = createClient({ baseUrl: BASE, worker: false, onError: (e) => (errSeen = e) });
  const boom = await errApi.get("/boom");
  check("500 does not throw", boom.status === false && boom.statusCode === 500);
  check("onError fired", errSeen?.statusCode === 500);
  errSeen = null;
  await errApi.get("/boom", { hideErrorMessage: true });
  check("hideErrorMessage suppresses onError", errSeen === null);

  const inv = await errApi.get("/invalid");
  check("field errors captured", inv.errors?.name?.[0] === "required");

  let threw = null;
  try {
    await errApi.get("/invalid", { throwError: true });
  } catch (e) {
    threw = e;
  }
  check("throwError throws on 4xx (was 5xx-only)", threw instanceof ApiError && threw.statusCode === 400);
  check("ApiError carries field errors", threw?.errors?.name?.[0] === "required");

  // ── timeout + abort ─────────────────────────────────────
  console.log("\ntimeout & abort");
  const t0 = Date.now();
  const slow = await api.get("/slow", { timeout: 300 });
  check("timeout → 408", slow.statusCode === 408, `got ${slow.statusCode}`);
  check("timeout is fast", Date.now() - t0 < 1200);

  const ac = new AbortController();
  ac.abort();
  const aborted = await api.get("/echo", { signal: ac.signal });
  check("caller AbortSignal is honoured (was ignored)", aborted.statusCode === 0 && !aborted.status);

  const ac2 = new AbortController();
  const inflight = api.get("/slow", { signal: ac2.signal });
  setTimeout(() => ac2.abort(), 100);
  const midAbort = await inflight;
  check("mid-flight abort works", midAbort.statusCode === 0);

  // ── bad addToUrl ────────────────────────────────────────
  const falsy = await api.get("/echo", { addToUrl: [null] });
  check("falsy addToUrl is a failure, not fake 200 (was status:true/200)", falsy.status === false && falsy.statusCode === 0);

  // ── auth flow ───────────────────────────────────────────
  console.log("\nauth");
  let authStates = [];
  const auth = createClient({
    baseUrl: BASE,
    worker: false,
    multiTab: false,
    onAuthStateChanged: (s) => authStates.push(s.isAuthenticated),
  });

  const badLogin = await auth.login({ password: "bad" });
  check("bad login fails", badLogin.status === false && badLogin.statusCode === 401);

  const ok = await auth.login({ password: "good" });
  check("login ok", ok.status === true);
  const st = await auth.getAuthState();
  check("authenticated after login", st.isAuthenticated === true);
  check("expiry parsed from JWT", typeof st.expiresAt === "number" && st.expiresAt > Date.now());
  check("user extracted", st.user?.name === "Ada");
  check("auth state observers fired", authStates.includes(true));

  const prot = await auth.get("/protected");
  check("authorized request ok", prot.status === true);

  // 401 → refresh → retry
  state.refreshCalls = 0;
  expireAccess();
  const retried = await auth.get("/protected");
  check("401 triggers refresh + retry", retried.status === true, JSON.stringify(retried.message));
  check("exactly one refresh", state.refreshCalls === 1, `got ${state.refreshCalls}`);

  // concurrent 401 stampede
  state.refreshCalls = 0;
  expireAccess();
  const burst = await Promise.all(Array.from({ length: 8 }, () => auth.get("/protected")));
  check("all 8 concurrent requests succeed", burst.every((r) => r.status === true));
  check("stampede coalesced into 1 refresh", state.refreshCalls === 1, `got ${state.refreshCalls}`);

  // logout
  await auth.logout();
  const afterLogout = await auth.getAuthState();
  check("logged out", afterLogout.isAuthenticated === false);

  // refresh failure → onAuthFailure
  let failed = false;
  const failing = createClient({
    baseUrl: BASE,
    worker: false,
    multiTab: false,
    onAuthFailure: () => (failed = true),
  });
  await failing.setTokens({ accessToken: "expired-now", refreshToken: "wrong" });
  const denied = await failing.get("/protected");
  check("failed refresh surfaces 401", denied.status === false);
  check("onAuthFailure fired", failed === true);

  // proactive refresh
  console.log("\nproactive refresh");
  state.refreshCalls = 0;
  const eager = createClient({ baseUrl: BASE, worker: false, multiTab: false, refreshSkewMs: 120_000 });
  await eager.login({ password: "good" });
  await eager.get("/protected");
  check("refreshes before expiry without a 401", state.refreshCalls === 1, `got ${state.refreshCalls}`);

  // ── transforms ──────────────────────────────────────────
  console.log("\ntransforms");
  const tr = await api.post(
    "/echo",
    { name: "ada" },
    {
      beforeFunc: (b) => ({ ...b, name: b.name.toUpperCase() }),
      afterFunc: (d) => d.body.name,
    },
  );
  check("beforeFunc + afterFunc", tr.data === "ADA", JSON.stringify(tr.data));

  // ── jwt util ────────────────────────────────────────────
  check("getTokenExpiry on opaque token → null", getTokenExpiry("not-a-jwt") === null);

  // ── setTokens / SSR seed ────────────────────────────────
  const ssr = createClient({ baseUrl: BASE, worker: false, multiTab: false });
  await ssr.setTokens({ accessToken: state.validAccess, refreshToken: "refresh-1" });
  const seeded = await ssr.get("/protected");
  check("SSR-seeded tokens work", seeded.status === true);

  api.destroy();
  auth.destroy();
  ssr.destroy();
} catch (e) {
  fail++;
  console.error("\nUNEXPECTED:", e);
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
