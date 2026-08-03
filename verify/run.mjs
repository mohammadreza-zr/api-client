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
  // throwError:false → envelope style, which is what this suite asserts.
  const api = createClient({ baseUrl: BASE, worker: false, refreshSkewMs: 0, throwError: false });
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
  const errApi = createClient({ baseUrl: BASE, worker: false, throwError: false, onError: (e) => (errSeen = e) });
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

  // Engines that drop the abort reason (Safari ≤ 18.x, WebKit bug 246069)
  // must still report a timeout as 408 — not as a cancellation.
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      try {
        return await realFetch(input, init);
      } catch (e) {
        if (e?.name === "TimeoutError" || e?.name === "AbortError") {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        throw e;
      }
    };
    try {
      const safari = createClient({ baseUrl: BASE, worker: false, refreshSkewMs: 0, onError: () => {} });
      let threw = false;
      let code = 0;
      let canceled;
      try {
        const r = await safari.get("/slow", { timeout: 300 });
        code = r.statusCode;
        canceled = r.canceled;
      } catch (e) {
        threw = true;
        code = e.statusCode;
        canceled = e.canceled;
      }
      check(
        "timeout stays 408 when the engine drops the abort reason (Safari)",
        threw && code === 408 && canceled !== true,
        `threw=${threw} code=${code} canceled=${canceled}`,
      );
      safari.destroy();
    } finally {
      globalThis.fetch = realFetch;
    }
  }

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
    throwError: false,
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

  // refresh() is a boolean verdict, not a token (the token never leaves the worker)
  const manualRefresh = await auth.refresh();
  check("refresh() resolves boolean true on success", manualRefresh === true, String(manualRefresh));

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
    throwError: false,
    onAuthFailure: () => (failed = true),
  });
  await failing.setTokens({ accessToken: "expired-now", refreshToken: "wrong" });
  const denied = await failing.get("/protected");
  check("failed refresh surfaces 401", denied.status === false);
  check("onAuthFailure fired", failed === true);

  // A NETWORK failure during refresh must NOT end the session —
  // only a server rejection does (a blip is not a logout).
  {
    let authFailures = 0;
    const net = createClient({
      baseUrl: BASE,
      worker: false,
      multiTab: false,
      refreshSkewMs: 0,
      throwError: false,
      onAuthFailure: () => authFailures++,
    });
    await net.login({ password: "good" });
    expireAccess();

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("/auth/refresh")) {
        throw new TypeError("network down");
      }
      return realFetch(input, init);
    };
    try {
      const res = await net.get("/protected");
      check("network-blip refresh: request surfaces 401", res.status === false && res.statusCode === 401);
      const stateAfter = await net.getAuthState();
      check(
        "network-blip refresh: session survives (was: logged out of every tab)",
        stateAfter.isAuthenticated === true,
      );
      check("network-blip refresh: onAuthFailure NOT fired", authFailures === 0, `got ${authFailures}`);
      // A direct refresh() call also reports false without clearing auth.
      const direct = await net.refresh();
      check("network-blip refresh: refresh() resolves false", direct === false);
      check("network-blip refresh: still authenticated after direct call", (await net.getAuthState()).isAuthenticated === true);
    } finally {
      globalThis.fetch = realFetch;
    }
    // The session is genuinely usable once the network is back.
    const recovered = await net.get("/protected");
    check("network-blip refresh: request succeeds once the network is back", recovered.status === true);
    net.destroy();
  }

  // A SERVER error (5xx) from the refresh endpoint must not end the session
  // either — only an authentication rejection (401/403) does.
  {
    let authFailures = 0;
    const srv = createClient({
      baseUrl: BASE,
      worker: false,
      multiTab: false,
      refreshSkewMs: 0,
      throwError: false,
      refreshUrl: "/auth/refresh-500",
      onAuthFailure: () => authFailures++,
    });
    await srv.login({ password: "good" });
    expireAccess();

    const res = await srv.get("/protected");
    check("5xx refresh: request surfaces 401", res.status === false && res.statusCode === 401);
    const stateAfter = await srv.getAuthState();
    check(
      "5xx refresh: session survives (was: any non-2xx logged out)",
      stateAfter.isAuthenticated === true,
    );
    check("5xx refresh: onAuthFailure NOT fired", authFailures === 0, `got ${authFailures}`);
    srv.destroy();
  }

  // proactive refresh
  console.log("\nproactive refresh");
  state.refreshCalls = 0;
  const eager = createClient({ baseUrl: BASE, worker: false, multiTab: false, refreshSkewMs: 120_000, throwError: false });
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
  const ssr = createClient({ baseUrl: BASE, worker: false, multiTab: false, throwError: false });
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
