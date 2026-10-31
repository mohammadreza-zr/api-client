/**
 * Drives the REAL inlined worker bundle through the REAL WorkerHost protocol.
 *
 * There is no browser here, so we polyfill `Worker`/`Blob`/`URL.createObjectURL`
 * and execute the worker source inside a vm context whose `self` is wired to a
 * message channel — the same contract a browser provides.
 */
import { start, state, expireAccess } from "./server.mjs";
import { FakeWorker, madeWorkers } from "./worker-harness.mjs";

const BASE = "http://localhost:4600";
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

const { server } = await start(4600);
const { createClient } = await import("../dist/index.js");

try {
  console.log("\nworker mode");
  let states = [];
  const api = createClient({
    baseUrl: BASE,
    multiTab: false,
    refreshSkewMs: 0,
    throwError: false, // envelope style — this suite asserts on result objects
    onAuthStateChanged: (s) => states.push(s.isAuthenticated),
  });

  check("worker mode engaged", api.isWorker === true);

  const echo = await api.get("/echo", { params: { a: 1, nested: { b: 2 }, list: [1, 2] } });
  check("GET through worker", echo.status === true);
  check(
    "worker uses SAME nested query serializer as main thread (was [object Object])",
    echo.data.query === "?a=1&nested%5Bb%5D=2&list=1&list=2",
    echo.data.query,
  );

  const posted = await api.post("/echo", { hi: 1 });
  check("POST through worker", posted.data.body.hi === 1);

  // transforms must survive the structured-clone boundary
  const tr = await api.post(
    "/echo",
    { name: "ada" },
    { beforeFunc: (b) => ({ ...b, name: b.name.toUpperCase() }), afterFunc: (d) => d.body.name },
  );
  check("beforeFunc/afterFunc work in worker mode (were dropped)", tr.data === "ADA", JSON.stringify(tr.data));

  // per-request baseUrl override
  const over = await api.get("/echo", { baseUrl: BASE });
  check("per-request baseUrl works in worker", over.status === true);

  // errors
  const boom = await api.get("/boom");
  check("500 handled in worker", boom.status === false && boom.statusCode === 500);
  const inv = await api.get("/invalid");
  check("field errors in worker", inv.errors?.name?.[0] === "required");

  // timeout parity
  const slow = await api.get("/slow", { timeout: 300 });
  check("worker timeout → 408 (parity with main thread)", slow.statusCode === 408, `got ${slow.statusCode}`);

  // auth in worker
  const login = await api.login({ password: "good" });
  check("login through worker", login.status === true);
  check(
    "worker: login response is stripped of tokens before crossing (was: access+refresh leaked)",
    !JSON.stringify(login.data).includes("eyJ") && !JSON.stringify(login.data).includes("refresh-"),
    JSON.stringify(login.data),
  );
  const loginFull = await api.login({ password: "good" }, { fullData: true });
  check(
    "worker: login stripped under fullData too (nested envelope)",
    loginFull.status === true &&
      !JSON.stringify(loginFull.data).includes("eyJ") &&
      !JSON.stringify(loginFull.data).includes("refresh-"),
    JSON.stringify(loginFull.data),
  );
  const st = await api.getAuthState();
  check("auth state readable", st.isAuthenticated === true);
  check("auth state carries NO tokens", !("accessToken" in st) && !JSON.stringify(st).includes("eyJ"));
  check("auth observers fired in worker", states.includes(true));

  const prot = await api.get("/protected");
  check("authorized request in worker", prot.status === true);

  // refresh() is a boolean in worker mode too — never the token, never ""
  const refreshed = await api.refresh();
  check("worker: refresh() resolves boolean true", refreshed === true, String(refreshed));

  state.refreshCalls = 0;
  expireAccess();
  const burst = await Promise.all(Array.from({ length: 6 }, () => api.get("/protected")));
  check("worker: 6 concurrent 401s all recover", burst.every((r) => r.status === true));
  check("worker: coalesced to 1 refresh", state.refreshCalls === 1, `got ${state.refreshCalls}`);

  // concurrent auth calls must not deadlock (old code shared one "__auth__" slot)
  const [l1, l2] = await Promise.all([api.login({ password: "good" }), api.login({ password: "bad" })]);
  check("overlapping login calls both settle (was: hang forever)", l1 !== undefined && l2 !== undefined);
  check("overlapping calls get distinct results", l1.status !== l2.status);

  await api.logout();
  check("logout in worker", (await api.getAuthState()).isAuthenticated === false);

  // ── subscribe parity: inline mode never fires immediately, worker must not ──
  {
    const fresh = createClient({ baseUrl: BASE, multiTab: false, refreshSkewMs: 0, throwError: false });
    let immediate = 0;
    fresh.onAuthStateChange(() => immediate++);
    await new Promise((r) => setTimeout(r, 60));
    check("worker: onAuthStateChange does not fire with stale state on subscribe", immediate === 0, `got ${immediate}`);
    fresh.destroy();
  }

  api.destroy();
  check("destroy is clean", true);

  // ── worker crash (memory mode): requests must settle, never hang ──
  console.log("\nworker crash — memory mode");
  {
    const crashApi = createClient({ baseUrl: BASE, multiTab: false, refreshSkewMs: 0, throwError: false });
    await crashApi.login({ password: "good" });
    check("crash test: session established", (await crashApi.getAuthState()).isAuthenticated === true);

    const owner = madeWorkers.at(-1);
    const inFlight = crashApi.get("/slow"); // /slow sleeps 2s — still in flight
    await new Promise((r) => setTimeout(r, 150));
    owner.crashNow();

    const t0 = Date.now();
    const inFlightRes = await inFlight;
    check(
      "crash: in-flight request settles (was: hung forever)",
      // 0, not 500: the server never answered, and a fake 500 makes data libraries retry a server error.
      inFlightRes.status === false && inFlightRes.statusCode === 0,
      JSON.stringify(inFlightRes.message),
    );

    const after = await crashApi.get("/echo");
    check(
      "crash: subsequent requests fail fast with an actionable message",
      after.status === false && after.statusCode === 0 && /crash/i.test(after.message),
      JSON.stringify(after.message),
    );
    check("crash: fail-fast is immediate", Date.now() - t0 < 1000);

    // destroy after a crash must not throw either.
    crashApi.destroy();
    check("crash: destroy after crash is clean", true);
  }

  // ── worker crash (persistent storage): one automatic restart, session kept ──
  console.log("\nworker crash — host storage restart");
  {
    let stored = null;
    const storage = {
      get: () => stored,
      set: (tokens) => {
        stored = tokens;
      },
      clear: () => {
        stored = null;
      },
    };

    const crashApi = createClient({
      baseUrl: BASE,
      multiTab: false,
      refreshSkewMs: 0,
      throwError: false,
      storage,
    });
    await crashApi.login({ password: "good" });
    check("restart test: session established and persisted", (await crashApi.getAuthState()).isAuthenticated === true);
    check("restart test: tokens live on the host", stored !== null);

    madeWorkers.at(-1).crashNow();

    // The restarted worker hydrates from host storage; the request must work.
    const res = await crashApi.get("/protected");
    check("crash: worker restarted from host storage, request succeeds", res.status === true, JSON.stringify(res.message));
    check("crash: session survived the restart", (await crashApi.getAuthState()).isAuthenticated === true);

    // A second crash must NOT restart again — it fails fast.
    madeWorkers.at(-1).crashNow();
    const second = await crashApi.get("/echo");
    check(
      "crash: a second crash fails fast (single restart only)",
      second.status === false && /cannot be restarted/i.test(second.message),
      JSON.stringify(second.message),
    );
    crashApi.destroy();
  }

  // ── declarative extractTokens / buildRefreshBody keep worker mode ──
  console.log("\nworker mode with declarative token mapping");
  {
    const mapped = createClient({
      baseUrl: BASE,
      multiTab: false,
      refreshSkewMs: 0,
      throwError: false,
      loginUrl: "/auth/login-exotic",
      refreshUrl: "/auth/refresh-exotic",
      // Exotic shape: { result: { jwt, renew, expires_in } } — nothing under
      // the default keys. Plain data, so worker mode must stay on.
      extractTokens: { accessKeys: ["jwt"], refreshKeys: ["renew"], expiresInKeys: ["expires_in"], roots: ["result"] },
      buildRefreshBody: { field: "refresh_token" },
    });
    check(
      "mapping: worker mode engaged (was: forced inline by functions)",
      mapped.isWorker === true,
    );

    const ml = await mapped.login({ password: "good" });
    check("mapping: custom-shape login succeeds", ml.status === true);
    check(
      "mapping: custom token keys are stripped from the login response too",
      !JSON.stringify(ml.data).includes("eyJ") && !JSON.stringify(ml.data).includes("renew"),
      JSON.stringify(ml.data),
    );
    check("mapping: session established", (await mapped.getAuthState()).isAuthenticated === true);

    const mp = await mapped.get("/protected");
    check("mapping: authorized request works", mp.status === true);

    // 401 → refresh with the declarative body shape
    state.refreshCalls = 0;
    expireAccess();
    const mr = await mapped.get("/protected");
    check("mapping: refresh + retry works", mr.status === true);
    check(
      "mapping: refresh body sent under the custom field",
      state.lastRefreshBody?.refresh_token === state.validRefresh,
      JSON.stringify(state.lastRefreshBody),
    );
    mapped.destroy();
  }

  // ── a 5xx from the refresh endpoint keeps the session in worker mode too ──
  console.log("\nworker mode — 5xx refresh keeps the session");
  {
    const srv = createClient({
      baseUrl: BASE,
      multiTab: false,
      refreshSkewMs: 0,
      throwError: false,
      refreshUrl: "/auth/refresh-500",
    });
    await srv.login({ password: "good" });
    expireAccess();
    const res = await srv.get("/protected");
    check("worker 5xx refresh: request surfaces 401", res.status === false && res.statusCode === 401);
    check(
      "worker 5xx refresh: session survives",
      (await srv.getAuthState()).isAuthenticated === true,
    );
    srv.destroy();
  }

  // ── client-wide throwError must behave identically in worker mode ──
  const strict = createClient({
    baseUrl: BASE,
    refreshSkewMs: 0,
    throwError: true,
    onError: () => {},
  });
  check("worker mode engaged for strict client", strict.isWorker === true);

  let workerThrew = false;
  let workerErr;
  try {
    await strict.get("/boom");
  } catch (e) {
    workerThrew = true;
    workerErr = e;
  }
  check("worker: client-wide throwError rejects", workerThrew);
  check(
    "worker: rejection is ApiError with statusCode 500",
    workerErr?.name === "ApiError" && workerErr?.statusCode === 500,
    `${workerErr?.name}/${workerErr?.statusCode}`,
  );

  const strictOk = await strict.get("/echo");
  check("worker: success still resolves under throwError", strictOk.status === true);

  let workerOptOut = false;
  try {
    const r = await strict.get("/boom", { throwError: false });
    workerOptOut = r.status === false && r.statusCode === 500;
  } catch {
    workerOptOut = false;
  }
  check("worker: per-request throwError:false overrides default", workerOptOut);

  strict.destroy();

  // ── CSRF must work in worker mode, where document.cookie does not exist ──
  const csrfApi = createClient({
    baseUrl: BASE,
    refreshSkewMs: 0,
    throwError: false,
    getCsrfToken: () => "worker-csrf-1", // a function cannot be cloned into the worker
    onError: () => {},
  });
  check("worker mode engaged with a CSRF provider", csrfApi.isWorker === true);

  const csrfEcho = await csrfApi.post("/echo", { a: 1 });
  check(
    "worker: CSRF header reaches the server",
    csrfEcho.data?.csrf === "worker-csrf-1",
    `got ${csrfEcho.data?.csrf}`,
  );

  const csrfGet = await csrfApi.get("/echo");
  check("worker: GET carries no CSRF header", !csrfGet.data?.csrf, `got ${csrfGet.data?.csrf}`);

  // A stream cannot be structured-cloned; the failure must be legible.
  const streamRes = await csrfApi.post(
    "/echo",
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("x"));
        c.close();
      },
    }),
  );
  check(
    "worker: stream body fails with a clear message, not DataCloneError",
    streamRes.status === false && /worker: false|Blob\/File\/FormData/i.test(streamRes.message),
    streamRes.message,
  );

  // A plain-object body with isFormData is converted inside the worker.
  const multipart = await csrfApi.post(
    "/raw",
    { name: "Ada", skipped: null, files: [new File(["W-ONE"], "one.txt"), new Blob(["W-TWO"])] },
    { isFormData: true },
  );
  check(
    "worker: isFormData object is sent as multipart",
    String(multipart.data?.ct).includes("multipart/form-data; boundary="),
    String(multipart.data?.ct),
  );
  check(
    "worker: isFormData keeps text, skips null and appends every file",
    multipart.data?.raw.includes('name="name"') &&
      !multipart.data.raw.includes('name="skipped"') &&
      (multipart.data.raw.match(/name="files"/g) ?? []).length === 2 &&
      multipart.data.raw.includes("W-ONE") &&
      multipart.data.raw.includes("W-TWO"),
  );

  // Values built in the page arrive in the worker as another realm's objects.
  const wMix = await csrfApi.post(
    "/raw",
    {
      bytes: new Uint8Array([72, 105, 33]),
      buf: new Uint8Array([1, 2]).buffer,
      when: new Date(0),
      bad: new Date("x"),
      set: new Set(["a", "b"]),
      nested: { n: 7n, m: new Map([["k", 1]]), d: new Date(0) },
      qs: new URLSearchParams({ a: "1" }),
      skip: undefined,
    },
    { isFormData: true },
  );
  const wRaw = wMix.data?.raw ?? "";
  check("worker: isFormData sends typed arrays as bytes", /name="bytes"[^]*?\r\n\r\nHi!\r\n/.test(wRaw) && !wRaw.includes('{"0"'), wMix.message);
  check("worker: isFormData sends an ArrayBuffer as bytes", /name="buf"[^]*?\r\n\r\n\x01\x02\r\n/.test(wRaw));
  check("worker: isFormData Date and invalid Date", wRaw.includes("1970-01-01T00:00:00.000Z") && !wRaw.includes('name="bad"'));
  check("worker: isFormData Set is appended item by item", (wRaw.match(/name="set"/g) ?? []).length === 2);
  check(
    "worker: isFormData nested bigint, Map and Date",
    wRaw.includes('{"n":"7","m":{"k":1},"d":"1970-01-01T00:00:00.000Z"}'),
  );
  check("worker: isFormData URLSearchParams", wRaw.includes("\r\n\r\na=1\r\n"));

  // A real FormData cannot be structured-cloned; it crosses the boundary as entries.
  const realForm = new FormData();
  realForm.append("title", "T");
  realForm.append("tags", "a");
  realForm.append("tags", "b");
  realForm.append("file", new File(["REAL-FILE-BYTES"], "real.txt", { type: "text/plain" }));
  const wForm = await csrfApi.post("/raw", realForm);
  const formRaw = wForm.data?.raw ?? "";
  check("worker: a real FormData body is sent (it used to fail to clone)", wForm.status === true, wForm.message);
  check(
    "worker: FormData keeps repeated keys, file name, type and bytes in order",
    (formRaw.match(/name="tags"/g) ?? []).length === 2 &&
      formRaw.includes('name="file"; filename="real.txt"') &&
      formRaw.includes("text/plain") &&
      formRaw.includes("REAL-FILE-BYTES") &&
      formRaw.indexOf('name="title"') < formRaw.indexOf('name="file"'),
  );
  check("worker: FormData content-type carries a boundary", String(wForm.data?.ct).includes("boundary="), String(wForm.data?.ct));

  const wNested = await csrfApi.post("/raw", { user: { avatar: new File(["x"], "a.png") } }, { isFormData: true });
  check(
    "worker: a File nested in an object fails with a clear message",
    wNested.status === false && /"user"/.test(wNested.message),
    wNested.message,
  );
  const wStream = await csrfApi.post(
    "/raw",
    { s: new ReadableStream({ start: (c) => c.close() }) },
    { isFormData: true },
  );
  check("worker: a stream inside an object fails instead of hanging", wStream.status === false, wStream.message);

  csrfApi.destroy();

  strict.destroy();

  /*
   * baseUrl auto-detection must survive the worker boundary.
   *
   * The worker runs from a Blob, so no bundler ever touched its source and it
   * has no `process` / `import.meta.env` of its own — note the vm scope above
   * deliberately omits `process`, exactly like a real browser worker. The host
   * therefore has to resolve `baseUrl` on the main thread and forward it. It
   * used to forward `undefined`, so every relative URL in worker mode was
   * silently sent to the page origin.
   */
  console.log("\nbaseUrl auto-detection in worker mode");

  check("worker scope genuinely has no process", (() => {
    const probe = new FakeWorker();
    const seen = typeof probe._scope.process;
    probe.terminate();
    return seen === "undefined";
  })());

  for (const key of ["NEXT_PUBLIC_API_URL", "VITE_API_URL", "API_URL"]) {
    process.env[key] = BASE;
    const detected = createClient({ multiTab: false, refreshSkewMs: 0, throwError: false });
    check(`worker mode engaged for ${key}`, detected.isWorker === true);
    const res = await detected.get("/echo");
    check(`worker inherits baseUrl from ${key} (was sent to page origin)`, res.status === true, res.message);
    detected.destroy();
    delete process.env[key];
  }

  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:9/wrong";
  const explicit = createClient({ baseUrl: BASE, multiTab: false, refreshSkewMs: 0, throwError: false });
  const explicitRes = await explicit.get("/echo");
  check("worker: explicit baseUrl still beats env", explicitRes.status === true);
  explicit.destroy();
  delete process.env.NEXT_PUBLIC_API_URL;
} catch (e) {
  fail++;
  console.error("\nUNEXPECTED:", e);
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
