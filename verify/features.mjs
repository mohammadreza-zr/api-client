/**
 * Verifies the three features added on top of the upload/react-query fixes:
 *   1. throwError defaults to true (and is overridable at both levels)
 *   2. long-upload token expiry (uploadSkewMs + stream retry behaviour)
 *   3. CSRF double-submit support
 * Not part of the package.
 */
import { createServer } from "node:http";
import { createClient, ApiError } from "../dist/index.js";

const PORT = 4630;
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

/** Builds a JWT whose exp is `seconds` from now. */
const jwt = (seconds) => {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256", typ: "JWT" })}.${b({ exp: Math.floor(Date.now() / 1000) + seconds })}.sig`;
};

const server_state = { refreshCalls: 0, lastCsrf: undefined, uploadHits: 0, lastAuth: undefined };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const json = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/auth/refresh") {
    server_state.refreshCalls++;
    return json(200, { data: { access: jwt(3600), refresh: "refresh-1" } });
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const size = Buffer.concat(chunks).length;

  if (url.pathname === "/csrf") {
    server_state.lastCsrf = req.headers["x-csrf-token"] ?? req.headers["x-xsrf-token"] ?? null;
    return json(200, { data: { csrf: server_state.lastCsrf } });
  }

  // 401 on the first attempt only.
  if (url.pathname === "/upload-once") {
    server_state.uploadHits++;
    if (server_state.uploadHits === 1) return json(401, { message: "expired" });
    return json(200, { data: { size } });
  }

  if (url.pathname === "/upload") {
    server_state.lastAuth = req.headers.authorization;
    return json(200, { data: { size } });
  }

  if (url.pathname === "/boom") return json(500, { message: "Internal Server Error" });
  json(200, { data: { ok: true } });
});
await new Promise((r) => server.listen(PORT, r));

try {
  // ── 1. throwError defaults to true ─────────────────────
  console.log("\n\x1b[1mthrowError default\x1b[0m");

  const api = createClient({ baseUrl: BASE, worker: false, refreshSkewMs: 0 });

  let threw = false;
  let err;
  try {
    await api.get("/boom");
  } catch (e) {
    threw = true;
    err = e;
  }
  check("failure REJECTS with no config at all", threw);
  check(
    "rejection is ApiError carrying statusCode",
    err instanceof ApiError && err.statusCode === 500,
    `${err?.constructor?.name}/${err?.statusCode}`,
  );

  const okRes = await api.get("/ok");
  check("success still resolves with the envelope", okRes.status === true && okRes.data.ok === true);

  // Opt out for one call.
  const envelope = await api.get("/boom", { throwError: false });
  check(
    "per-request throwError:false returns the envelope",
    envelope.status === false && envelope.statusCode === 500,
  );

  // Opt out globally.
  const legacy = createClient({ baseUrl: BASE, worker: false, refreshSkewMs: 0, throwError: false });
  const legacyRes = await legacy.get("/boom");
  check("client throwError:false restores envelope style", legacyRes.status === false);

  // And re-enable for a single call on an envelope-style client.
  let legacyThrew = false;
  try {
    await legacy.get("/boom", { throwError: true });
  } catch {
    legacyThrew = true;
  }
  check("per-request throwError:true overrides client false", legacyThrew);

  // ── 2. Long-upload token expiry ────────────────────────
  console.log("\n\x1b[1mlong upload + token expiry\x1b[0m");

  // A token with 60s left passes the default 30s skew, so no refresh happens —
  // but a multi-minute upload would expire mid-flight.
  server_state.refreshCalls = 0;
  const up = createClient({ baseUrl: BASE, worker: false, refreshSkewMs: 30_000 });
  await up.setTokens({ accessToken: jwt(60), refreshToken: "refresh-1" });

  await up.post("/upload", new Blob([new Uint8Array(1024)]));
  check(
    "no refresh for a normal request with 60s of life left",
    server_state.refreshCalls === 0,
    `refreshes=${server_state.refreshCalls}`,
  );

  // Same token, but the caller declares this upload may run for 10 minutes.
  await up.post("/upload", new Blob([new Uint8Array(1024)]), { uploadSkewMs: 600_000 });
  check(
    "uploadSkewMs refreshes BEFORE a long upload starts",
    server_state.refreshCalls === 1,
    `refreshes=${server_state.refreshCalls}`,
  );

  const freshToken = server_state.lastAuth;
  check("long upload carries the refreshed token", typeof freshToken === "string" && freshToken.startsWith("Bearer "));

  // uploadSkewMs must not fire when the token is genuinely healthy.
  server_state.refreshCalls = 0;
  const healthy = createClient({ baseUrl: BASE, worker: false });
  await healthy.setTokens({ accessToken: jwt(7200), refreshToken: "refresh-1" });
  await healthy.post("/upload", new Blob([new Uint8Array(16)]), { uploadSkewMs: 600_000 });
  check(
    "uploadSkewMs is a no-op when the token outlives the window",
    server_state.refreshCalls === 0,
    `refreshes=${server_state.refreshCalls}`,
  );

  // A replayable body (Blob) still recovers from a mid-flight 401.
  server_state.uploadHits = 0;
  const replay = createClient({ baseUrl: BASE, worker: false, refreshSkewMs: 0 });
  await replay.setTokens({ accessToken: "stale", refreshToken: "refresh-1" });
  const replayed = await replay.post("/upload-once", new Blob([new Uint8Array(4096)]));
  check(
    "Blob upload survives a mid-flight 401 (re-sent intact)",
    replayed.status === true && replayed.data.size === 4096,
    `status=${replayed.statusCode} size=${replayed.data?.size}`,
  );

  // A stream cannot be replayed — it must fail with a clear, actionable message.
  server_state.uploadHits = 0;
  const streamed = createClient({ baseUrl: BASE, worker: false, refreshSkewMs: 0, throwError: false });
  await streamed.setTokens({ accessToken: "stale", refreshToken: "refresh-1" });
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("STREAMED-PAYLOAD"));
      c.close();
    },
  });
  const streamRes = await streamed.post("/upload-once", stream);
  check(
    "stream body: no opaque 'disturbed or locked' crash",
    !String(streamRes.message).includes("disturbed"),
    streamRes.message,
  );
  check(
    "stream body: message explains the retry",
    streamRes.status === false && /retry the upload/i.test(streamRes.message),
    streamRes.message,
  );

  // The stream case still uploads successfully when the token is fresh.
  server_state.uploadHits = 5; // past the 401 branch
  const goodStream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("HELLO-STREAM"));
      c.close();
    },
  });
  const goodRes = await streamed.post("/upload-once", goodStream);
  check(
    "stream body uploads fine when no 401 occurs (duplex handled)",
    goodRes.status === true && goodRes.data.size === 12,
    `status=${goodRes.statusCode} msg=${goodRes.message} size=${goodRes.data?.size}`,
  );

  // ── 3. CSRF ────────────────────────────────────────────
  console.log("\n\x1b[1mCSRF double-submit\x1b[0m");

  // No document in Node, so use the provider form (also the worker-safe path).
  const csrf = createClient({
    baseUrl: BASE,
    worker: false,
    refreshSkewMs: 0,
    getCsrfToken: () => "token-abc",
  });

  server_state.lastCsrf = undefined;
  await csrf.post("/csrf", { a: 1 });
  check("POST carries the CSRF header", server_state.lastCsrf === "token-abc", `got ${server_state.lastCsrf}`);

  server_state.lastCsrf = undefined;
  await csrf.get("/csrf");
  check(
    "GET does NOT carry it (safe method)",
    server_state.lastCsrf === null || server_state.lastCsrf === undefined,
    `got ${server_state.lastCsrf}`,
  );

  server_state.lastCsrf = undefined;
  await csrf.delete("/csrf");
  check("DELETE carries it", server_state.lastCsrf === "token-abc", `got ${server_state.lastCsrf}`);

  // Custom header name.
  const customHeader = createClient({
    baseUrl: BASE,
    worker: false,
    refreshSkewMs: 0,
    xsrfHeaderName: "X-XSRF-TOKEN",
    getCsrfToken: () => "custom-1",
  });
  server_state.lastCsrf = undefined;
  await customHeader.post("/csrf", {});
  check("custom xsrfHeaderName respected", server_state.lastCsrf === "custom-1", `got ${server_state.lastCsrf}`);

  // An explicit per-request header must win.
  server_state.lastCsrf = undefined;
  await csrf.post("/csrf", {}, { headers: { "X-CSRF-Token": "manual-override" } });
  check(
    "explicit header is not overwritten",
    server_state.lastCsrf === "manual-override",
    `got ${server_state.lastCsrf}`,
  );

  // Cookie-based reading, via a minimal document shim.
  globalThis.document = { cookie: "other=1; csrftoken=from-cookie; x=2" };
  const cookieCsrf = createClient({
    baseUrl: BASE,
    worker: false,
    refreshSkewMs: 0,
    xsrfCookieName: "csrftoken",
  });
  server_state.lastCsrf = undefined;
  await cookieCsrf.post("/csrf", {});
  check("token read from document.cookie", server_state.lastCsrf === "from-cookie", `got ${server_state.lastCsrf}`);
  delete globalThis.document;

  // No CSRF configured → no header, no crash.
  server_state.lastCsrf = undefined;
  await api.post("/csrf", {});
  check(
    "no CSRF config → no header sent",
    server_state.lastCsrf === null || server_state.lastCsrf === undefined,
    `got ${server_state.lastCsrf}`,
  );

  // A throwing provider must not break the request.
  const badProvider = createClient({
    baseUrl: BASE,
    worker: false,
    refreshSkewMs: 0,
    getCsrfToken: () => {
      throw new Error("no token");
    },
  });
  const survived = await badProvider.post("/csrf", {});
  check("a throwing CSRF provider does not break the request", survived.status === true);
} catch (e) {
  fail++;
  console.error("\nUNEXPECTED:", e);
} finally {
  server.close();
}

console.log(`\n\x1b[1mresult\x1b[0m  ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\n\x1b[1mfailures\x1b[0m");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail ? 1 : 0);
