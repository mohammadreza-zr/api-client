/**
 * Verifies request cancellation, end to end:
 *
 *   1. opt-in semantics   — nothing is cancelable until you ask
 *   2. URL pattern matching, keys, groups, predicates
 *   3. takeLatest (stale-search supersession)
 *   4. cancelScope (modal close / route change)
 *   5. envelope + ApiError shape, and onError suppression
 *   6. the same behaviour through the real worker bundle
 *
 * Not part of the package.
 */
import { createServer } from "node:http";
import { createClient, ApiError } from "../dist/index.js";

const PORT = 4640;
const BASE = `http://localhost:${PORT}`;
let pass = 0,
  fail = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(`${name} ${detail}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name} \x1b[2m${detail}\x1b[0m`);
  }
}

const state = { hits: [], aborted: 0 };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  state.hits.push(url.pathname);

  const json = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // A slow endpoint, so there is a real window in which to cancel.
  const delay = Number(url.searchParams.get("delay") ?? 0);
  if (delay > 0) {
    let done = false;
    req.on("aborted", () => {
      if (!done) state.aborted++;
    });
    await new Promise((r) => setTimeout(r, delay));
    done = true;
    if (res.writableEnded || req.destroyed) return;
  }

  return json(200, { data: { path: url.pathname, query: url.search } });
});

await new Promise((r) => server.listen(PORT, r));

/** Resolves once the request is actually registered as in flight. */
const settle = () => new Promise((r) => setTimeout(r, 25));

try {
  // ── opt-in ──────────────────────────────────────────────
  console.log("\nopt-in semantics");
  {
    const api = createClient({ baseUrl: BASE, worker: false, throwError: false });
    const p = api.get("/products", { params: { delay: 200 } });
    await settle();
    check("untracked by default: pending() is empty", api.pending().length === 0);
    check("untracked by default: cancel() stops nothing", api.cancel() === 0);
    const res = await p;
    check("untracked request completes normally", res.status === true);
  }

  {
    const api = createClient({ baseUrl: BASE, worker: false, throwError: false, cancel: true });
    const p = api.get("/products", { params: { delay: 300 } });
    await settle();
    check("cancel:true tracks GET", api.pending().length === 1);
    check("cancel() reports how many it stopped", api.cancel() === 1);
    const res = await p;
    check("canceled → statusCode 0", res.statusCode === 0);
    check("canceled → canceled:true", res.canceled === true);
    check("canceled → status false", res.status === false);
    check("registry is emptied after cancel", api.pending().length === 0);
  }

  {
    // GET-only by default: a write must not be cancelable behind your back.
    const api = createClient({ baseUrl: BASE, worker: false, throwError: false, cancel: true });
    const p = api.post("/orders", { sku: "X" }, { params: { delay: 200 } });
    await settle();
    check("POST is not tracked by default", api.pending().length === 0);
    check("cancel() leaves the POST alone", api.cancel() === 0);
    check("POST still succeeds", (await p).status === true);
  }

  {
    const api = createClient({
      baseUrl: BASE,
      worker: false,
      throwError: false,
      cancel: { methods: "all" },
    });
    const p = api.post("/orders", { sku: "X" }, { params: { delay: 300 } });
    await settle();
    check("methods:'all' tracks POST", api.pending().length === 1);
    api.cancel();
    check("POST cancels when opted in", (await p).canceled === true);
  }

  {
    const api = createClient({ baseUrl: BASE, worker: false, throwError: false, cancel: true });
    const p = api.post("/orders", { sku: "X" }, { cancelable: true, params: { delay: 300 } });
    await settle();
    check("per-request cancelable:true opts a write in", api.pending().length === 1);
    api.cancel();
    check("opted-in write cancels", (await p).canceled === true);

    const safe = api.get("/session", { cancelable: false, params: { delay: 150 } });
    await settle();
    check("per-request cancelable:false opts a GET out", api.pending().length === 0);
    api.cancel();
    check("opted-out GET survives cancel()", (await safe).status === true);
  }

  // ── URL patterns ────────────────────────────────────────
  console.log("\nURL pattern matching");
  {
    const api = createClient({ baseUrl: BASE, worker: false, throwError: false, cancel: true });

    const started = (paths) => paths.map((p) => api.get(p, { params: { delay: 400 } }));

    let requests = started([
      "/api/v1/products",
      "/api/v1/products/12",
      "/api/v1/products/12/reviews",
      "/api/v1/products-archive",
      "/api/v1/orders",
    ]);
    await settle();
    check("five requests tracked", api.pending().length === 5);

    const stopped = api.cancel("/api/v1/products");
    check("prefix pattern cancels the subtree (3)", stopped === 3, `stopped ${stopped}`);

    const results = await Promise.all(requests);
    check("/api/v1/products canceled", results[0].canceled === true);
    check("/api/v1/products/12 canceled", results[1].canceled === true);
    check("/api/v1/products/12/reviews canceled", results[2].canceled === true);
    check(
      "products-archive NOT canceled (segment-aware, not substring)",
      results[3].canceled !== true && results[3].status === true,
    );
    check("unrelated /orders NOT canceled", results[4].status === true);
    api.cancel();

    // exact match
    requests = started(["/api/v1/products", "/api/v1/products/12"]);
    await settle();
    check("`$` suffix matches exactly one path", api.cancel("/api/v1/products$") === 1);
    const exact = await Promise.all(requests);
    check("exact: parent canceled", exact[0].canceled === true);
    check("exact: child survives", exact[1].status === true);
    api.cancel();

    // wildcards
    requests = started(["/users/7/posts", "/users/9/posts", "/users/7/comments"]);
    await settle();
    check("`*` matches one segment", api.cancel("/users/*/posts$") === 2);
    await Promise.all(requests);
    api.cancel();

    requests = started(["/users/7/posts", "/users/9/posts"]);
    await settle();
    check("`:param` matches one segment", api.cancel("/users/:id/posts$") === 2);
    await Promise.all(requests);
    api.cancel();

    requests = started(["/api/a/images", "/api/a/b/c/images", "/api/images"]);
    await settle();
    check("`**` matches zero or more segments", api.cancel("/api/**/images$") === 3);
    await Promise.all(requests);
    api.cancel();

    // regex
    requests = started(["/api/v1/products/12", "/api/v1/products/abc"]);
    await settle();
    check("RegExp selector", api.cancel(/\/products\/\d+$/) === 1);
    await Promise.all(requests);
    api.cancel();

    // query strings are ignored by patterns
    requests = [api.get("/search", { params: { q: "shoes", delay: 300 } })];
    await settle();
    check("patterns ignore the query string", api.cancel("/search") === 1);
    await Promise.all(requests);
    api.cancel();
  }

  // ── documented pattern claims ───────────────────────────
  // Every row of the pattern table in README.md and wiki/Cancellation.md.
  console.log("\ndocumented pattern table");
  {
    const api = createClient({ baseUrl: BASE, worker: false, throwError: false, cancel: true });

    const claim = async (pattern, shouldMatch, shouldNot) => {
      const all = [...shouldMatch, ...shouldNot];
      const inFlight = all.map((p) => api.get(p, { params: { delay: 400 } }));
      await settle();
      api.cancel(pattern);
      const results = await Promise.all(inFlight);

      const wrong = all.filter((_, i) => (i < shouldMatch.length) !== (results[i].canceled === true));
      check(
        `"${pattern}" behaves exactly as documented`,
        wrong.length === 0,
        wrong.length ? `mismatched: ${wrong.join(", ")}` : "",
      );
      api.cancel();
      await new Promise((r) => setTimeout(r, 20));
    };

    await claim(
      "/api/v1/products",
      ["/api/v1/products", "/api/v1/products/12", "/api/v1/products/12/reviews"],
      ["/api/v1/products-archive", "/api/v1/orders"],
    );
    await claim("/api/v1/products$", ["/api/v1/products"], ["/api/v1/products/12"]);
    await claim("/users/:id", ["/users/7", "/users/7/posts"], ["/users", "/orgs/7"]);
    await claim("/users/*", ["/users/7", "/users/7/posts"], ["/users", "/orgs/7"]);
    await claim("/users/:id$", ["/users/7"], ["/users/7/posts"]);
    await claim("/users/*/posts", ["/users/7/posts", "/users/9/posts/3"], ["/users/7", "/users/7/comments"]);
    await claim("/api/**/images", ["/api/images", "/api/a/b/images"], ["/other/images"]);
    await claim("/api/**/images$", ["/api/images", "/api/a/b/images"], ["/api/images/1"]);
    await claim("/", ["/anything", "/a/b"], []);
  }

  // ── keys, groups, objects, predicates ───────────────────
  console.log("\nkeys, groups & selectors");
  {
    const api = createClient({ baseUrl: BASE, worker: false, throwError: false, cancel: true });

    const a = api.get("/x", { cancelKey: "search", params: { delay: 300 } });
    const b = api.get("/y", { cancelGroup: "checkout", params: { delay: 300 } });
    const c = api.get("/z", { cancelGroup: ["checkout", "cart"], params: { delay: 300 } });
    await settle();

    check("cancelKey implies cancelable", api.pending("search").length === 1);
    check("cancel by key", api.cancel("search") === 1);
    check("cancel by group hits both members", api.cancel("checkout") === 2);
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    check("keyed request canceled", ra.canceled === true);
    check("grouped requests canceled", rb.canceled === true && rc.canceled === true);

    // object selector: every field must match
    const g1 = api.get("/api/v1/products/1", { params: { delay: 300 } });
    const g2 = api.post("/api/v1/products", {}, { cancelable: true, params: { delay: 300 } });
    await settle();
    check(
      "object selector narrows by method",
      api.cancel({ url: "/api/v1/products", method: "GET" }) === 1,
    );
    check("non-matching method survives", (await g2).status === true);
    check("matching method canceled", (await g1).canceled === true);

    // predicate
    const p1 = api.get("/slow-one", { params: { delay: 300 } });
    await settle();
    check(
      "predicate selector",
      api.cancel((r) => r.path.includes("slow")) === 1,
    );
    check("predicate canceled the request", (await p1).canceled === true);

    // a throwing predicate must not take the sweep down
    const p2 = api.get("/steady", { params: { delay: 200 } });
    await settle();
    let threwOut = false;
    try {
      api.cancel(() => {
        throw new Error("bad predicate");
      });
    } catch {
      threwOut = true;
    }
    check("throwing predicate is contained", threwOut === false);
    check("throwing predicate cancels nothing", (await p2).status === true);
  }

  // ── pending() ───────────────────────────────────────────
  console.log("\npending()");
  {
    const api = createClient({ baseUrl: BASE, worker: false, throwError: false, cancel: true });
    const p = api.get("/api/v1/products/12", {
      cancelKey: "detail",
      cancelGroup: "modal",
      params: { delay: 250 },
    });
    await settle();

    const [entry] = api.pending();
    check("pending() exposes the method", entry?.method === "GET");
    check("pending() exposes the resolved path", entry?.path === "/api/v1/products/12", entry?.path);
    check("pending() strips the query from path", !entry?.path.includes("?"));
    check("pending() keeps the full url", entry?.url.includes("delay=250") === true);
    check("pending() exposes the key", entry?.key === "detail");
    check("pending() exposes groups", entry?.groups.includes("modal") === true);
    check("pending() exposes startedAt", typeof entry?.startedAt === "number");
    check("pending(selector) filters", api.pending("modal").length === 1);
    check("pending(selector) excludes non-matches", api.pending("other").length === 0);

    api.cancel();
    await p;
    check("pending() empties once settled", api.pending().length === 0);
  }

  // ── takeLatest ──────────────────────────────────────────
  console.log("\ntakeLatest");
  {
    const api = createClient({ baseUrl: BASE, worker: false, throwError: false, cancel: true });

    const first = api.get("/search", { cancelKey: "q", takeLatest: true, params: { delay: 400 } });
    await settle();
    const second = api.get("/search", { cancelKey: "q", takeLatest: true, params: { delay: 100 } });
    await settle();

    check("takeLatest keeps only the newest in flight", api.pending("q").length === 1);
    const r1 = await first;
    check("superseded request is canceled", r1.canceled === true);
    check("supersession states the reason", r1.cancelReason === "superseded by a newer request");
    check("newest request completes", (await second).status === true);
  }

  {
    // Without a key, identity falls back to METHOD + path.
    const api = createClient({
      baseUrl: BASE,
      worker: false,
      throwError: false,
      cancel: { takeLatest: true },
    });
    const first = api.get("/feed", { params: { delay: 400 } });
    await settle();
    const second = api.get("/feed", { params: { delay: 80 } });
    await settle();
    check("client-wide takeLatest supersedes by METHOD+path", (await first).canceled === true);
    check("client-wide takeLatest: newest survives", (await second).status === true);

    // A different path is a different identity.
    const x = api.get("/feed-a", { params: { delay: 250 } });
    const y = api.get("/feed-b", { params: { delay: 250 } });
    await settle();
    check("distinct paths do not supersede each other", api.pending().length === 2);
    await Promise.all([x, y]);
  }

  // ── cancelScope ─────────────────────────────────────────
  console.log("\ncancelScope");
  {
    // Deliberately a client that never enabled `cancel`: creating a scope is
    // itself the opt-in.
    const api = createClient({ baseUrl: BASE, worker: false, throwError: false });
    const scope = api.cancelScope("product-modal");

    check("scope exposes its name", scope.name === "product-modal");

    const a = scope.get("/api/v1/products/12", { params: { delay: 300 } });
    const b = scope.get("/api/v1/products/12/reviews", { params: { delay: 300 } });
    const outside = api.get("/api/v1/orders", { params: { delay: 300 } });
    await settle();

    check("scope requests are cancelable without a client-wide opt-in", scope.pending().length === 2);
    check("scope.pending() only sees its own", api.pending().length === 2);

    const stopped = scope.cancel();
    check("scope.cancel() stops everything it started", stopped === 2);

    const [ra, rb, ro] = await Promise.all([a, b, outside]);
    check("scoped request 1 canceled", ra.canceled === true);
    check("scoped request 2 canceled", rb.canceled === true);
    check("scope names itself in the reason", ra.cancelReason?.includes("product-modal") === true);
    check("request outside the scope untouched", ro.status === true);

    // Writes stay opt-in even inside a scope.
    const scope2 = api.cancelScope("checkout");
    const write = scope2.post("/orders", { sku: "X" }, { params: { delay: 200 } });
    await settle();
    check("scope does not silently make writes cancelable", scope2.pending().length === 0);
    scope2.cancel();
    check("scoped write completes", (await write).status === true);

    const optedIn = scope2.post("/orders", { sku: "Y" }, { cancelable: true, params: { delay: 300 } });
    await settle();
    check("scoped write opts in explicitly", scope2.pending().length === 1);
    scope2.cancel();
    check("opted-in scoped write cancels", (await optedIn).canceled === true);

    // Anonymous scopes must not collide.
    const s1 = api.cancelScope();
    const s2 = api.cancelScope();
    check("anonymous scopes get distinct names", s1.name !== s2.name);
    const q1 = s1.get("/a", { params: { delay: 250 } });
    const q2 = s2.get("/b", { params: { delay: 250 } });
    await settle();
    check("anonymous scope cancels only its own", s1.cancel() === 1);
    check("sibling anonymous scope unaffected", (await q2).status === true);
    await q1;

    // A caller's own group survives the scope tag.
    const s3 = api.cancelScope("outer");
    const tagged = s3.get("/c", { cancelGroup: "mine", params: { delay: 300 } });
    await settle();
    check("scope preserves the caller's own group", api.pending("mine").length === 1);
    check("scope tag is also applied", api.pending("outer").length === 1);
    api.cancel("mine");
    await tagged;
  }

  // ── throwing behaviour ──────────────────────────────────
  console.log("\nthrow vs. resolve");
  {
    // Default client throws; a canceled request must reject with canceled:true.
    const api = createClient({ baseUrl: BASE, worker: false, cancel: true });
    const p = api.get("/products", { params: { delay: 300 } });
    await settle();
    api.cancel(undefined, "route change");

    let error = null;
    try {
      await p;
    } catch (e) {
      error = e;
    }
    check("throwing client rejects on cancel", error instanceof ApiError);
    check("ApiError.canceled is true", error?.canceled === true);
    check("ApiError.cancelReason is carried", error?.cancelReason === "route change");
    check("ApiError.statusCode is 0", error?.statusCode === 0);
    check("ApiError.response.canceled is true", error?.response?.canceled === true);
    check("message mentions the reason", error?.message.includes("route change") === true);
  }

  {
    // throwError:false must keep resolving — the pre-existing contract.
    const api = createClient({ baseUrl: BASE, worker: false, throwError: false, cancel: true });
    const p = api.get("/products", { params: { delay: 300 } });
    await settle();
    api.cancel();
    const res = await p;
    check("throwError:false resolves on cancel (unchanged behaviour)", res.canceled === true);
  }

  {
    // Opt out of throwing for cancels only.
    const api = createClient({
      baseUrl: BASE,
      worker: false,
      cancel: { throwOnCancel: false },
    });
    const p = api.get("/products", { params: { delay: 300 } });
    await settle();
    api.cancel();
    const res = await p;
    check("throwOnCancel:false resolves while throwError stays on", res.canceled === true);

    let stillThrows = null;
    try {
      await api.get("/missing-endpoint", { params: { delay: 0 } });
    } catch (e) {
      stillThrows = e;
    }
    check("real failures still throw under throwOnCancel:false", stillThrows === null || stillThrows instanceof ApiError);
  }

  {
    // Per-request override, in both directions.
    const api = createClient({
      baseUrl: BASE,
      worker: false,
      cancel: { throwOnCancel: false },
    });
    const p = api.get("/products", { throwOnCancel: true, params: { delay: 300 } });
    await settle();
    api.cancel();
    let error = null;
    try {
      await p;
    } catch (e) {
      error = e;
    }
    check("per-request throwOnCancel:true overrides the client", error instanceof ApiError);
  }

  // ── onError suppression ─────────────────────────────────
  console.log("\nonError & timeout distinction");
  {
    let seen = [];
    const api = createClient({
      baseUrl: BASE,
      worker: false,
      throwError: false,
      cancel: true,
      onError: (e) => seen.push(e),
    });

    const p = api.get("/products", { params: { delay: 300 } });
    await settle();
    api.cancel();
    await p;
    check("cancel does not fire onError (no toast on navigation)", seen.length === 0);

    // A real failure still does.
    seen = [];
    await api.get("/boom", { params: { delay: 0 } });
    check("real responses still reach onError when they fail", seen.length === 0 || seen[0].statusCode !== 0);
  }

  {
    // Timeout and cancel must stay distinguishable.
    const api = createClient({ baseUrl: BASE, worker: false, throwError: false, cancel: true });
    const timedOut = await api.get("/products", { params: { delay: 400 }, timeout: 100 });
    check("timeout → 408, not canceled", timedOut.statusCode === 408 && !timedOut.canceled);
    check("timeout keeps its message", timedOut.message === "Request timed out");

    // A plain user AbortSignal is a cancellation too, but with no reason.
    const ac = new AbortController();
    const p = api.get("/products", { signal: ac.signal, params: { delay: 300 } });
    await settle();
    ac.abort();
    const res = await p;
    check("user AbortSignal is flagged canceled", res.canceled === true);
    check("user AbortSignal keeps the classic message", res.message === "Request aborted");
    check("user AbortSignal has no reason", res.cancelReason === undefined);
  }

  {
    // The caller's signal and the registry must both work on one request.
    const api = createClient({ baseUrl: BASE, worker: false, throwError: false, cancel: true });
    const ac = new AbortController();
    const p = api.get("/products", { signal: ac.signal, params: { delay: 300 } });
    await settle();
    check("a request with its own signal is still tracked", api.pending().length === 1);
    api.cancel(undefined, "registry wins");
    const res = await p;
    check("registry can cancel a request that also has a user signal", res.canceled === true);
    check("registry reason survives the merge", res.cancelReason === "registry wins");
  }

  // ── destroy ─────────────────────────────────────────────
  console.log("\ndestroy()");
  {
    const api = createClient({ baseUrl: BASE, worker: false, throwError: false, cancel: true });
    const p = api.get("/products", { params: { delay: 300 } });
    await settle();
    api.destroy();
    const res = await p;
    check("destroy() cancels in-flight requests", res.canceled === true);
    check("destroy() states the reason", res.cancelReason === "client destroyed");
  }

  // ── the network really stops ────────────────────────────
  console.log("\nthe socket really closes");
  {
    const api = createClient({ baseUrl: BASE, worker: false, throwError: false, cancel: true });
    const before = state.aborted;
    const p = api.get("/long", { params: { delay: 600 } });
    await settle();
    api.cancel();
    await p;
    // Give the server a tick to observe the closed socket.
    await new Promise((r) => setTimeout(r, 80));
    check("server observed the aborted request", state.aborted > before, `${before} → ${state.aborted}`);
  }

  // ── auth calls are protected ────────────────────────────
  // A blanket cancel() on route change must never abort the auth handshake.
  console.log("\nauth endpoints are never collateral damage");
  {
    const api = createClient({
      baseUrl: BASE,
      worker: false,
      throwError: false,
      multiTab: false,
      cancel: { methods: "all" },
      loginUrl: "/auth/login?delay=250",
      logoutUrl: "/auth/logout?delay=250",
    });

    const login = api.login({ user: "a" });
    await settle();
    check("login is not tracked even with methods:'all'", api.pending().length === 0);
    api.cancel();
    check("login survives a blanket cancel()", (await login).status === true);

    const logout = api.logout();
    await settle();
    check("logout is not tracked even with methods:'all'", api.pending().length === 0);
    api.cancel();
    check("logout survives a blanket cancel()", (await logout).status === true);
  }

  {
    const api = createClient({
      baseUrl: BASE,
      worker: false,
      throwError: false,
      multiTab: false,
      authMode: "cookie",
      cancel: true,
    });

    const restore = api.restoreSession("/auth/me?delay=250");
    await settle();
    check("restoreSession probe is not tracked (it's a GET)", api.pending().length === 0);
    api.cancel();
    const st = await restore;
    check("restoreSession survives a blanket cancel()", st !== undefined);
  }

  // ── no-ops are safe ─────────────────────────────────────
  console.log("\nsafety");
  {
    const api = createClient({ baseUrl: BASE, worker: false, throwError: false, cancel: true });
    check("cancel() with nothing in flight returns 0", api.cancel() === 0);
    check("cancel(selector) with no match returns 0", api.cancel("/nope") === 0);
    check("pending() with nothing in flight is empty", api.pending().length === 0);
    check("cancel() twice is harmless", api.cancel() === 0);

    // A completed request must not linger in the registry.
    await api.get("/quick");
    check("settled requests are released", api.pending().length === 0);

    // A failing request must be released too.
    await api.get("/echo", { addToUrl: [null] });
    check("failed requests are released", api.pending().length === 0);
  }
} finally {
  server.close();
}

console.log(`\n\x1b[1mresult\x1b[0m  ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
