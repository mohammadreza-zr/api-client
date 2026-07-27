/** Adversarial audit: upload integrity + react-query / SWR integration. Not part of the package. */
import { start, state } from "./audit-server.mjs";
import { createClient, ApiError } from "../dist/index.js";
import { QueryClient, QueryObserver, MutationObserver } from "@tanstack/query-core";

const BASE = "http://localhost:4610";
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

const { server } = await start(4610);
const api = createClient({ baseUrl: BASE, worker: false, refreshSkewMs: 0 });

try {
  // ── 1. Binary / upload integrity ──────────────────────
  console.log("\n\x1b[1mupload integrity\x1b[0m");

  // Uint8Array: the classic "typed array gets JSON-stringified" bug.
  const bytes = new Uint8Array([9, 9, 9]);
  const r1 = await api.post("/upload", bytes);
  check(
    "Uint8Array sent as 3 raw bytes",
    r1.data.byteLength === 3,
    `got ${r1.data.byteLength} bytes, text=${JSON.stringify(r1.data.text)}`,
  );
  check(
    "Uint8Array not labelled application/json",
    !String(r1.data.contentType).includes("application/json"),
    `CT=${r1.data.contentType}`,
  );

  // Blob
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "application/octet-stream" });
  const r2 = await api.post("/upload", blob);
  check("Blob sent as 4 raw bytes", r2.data.byteLength === 4, `got ${r2.data.byteLength}`);
  check(
    "Blob keeps its own content-type",
    String(r2.data.contentType).includes("octet-stream"),
    `CT=${r2.data.contentType}`,
  );

  // ArrayBuffer
  const r3 = await api.post("/upload", new Uint8Array([7, 7, 7, 7, 7]).buffer);
  check("ArrayBuffer sent as 5 raw bytes", r3.data.byteLength === 5, `got ${r3.data.byteLength}`);
  check(
    "ArrayBuffer not labelled application/json",
    !String(r3.data.contentType).includes("application/json"),
    `CT=${r3.data.contentType}`,
  );

  // URLSearchParams
  const r4 = await api.post("/upload", new URLSearchParams({ a: "1", b: "2" }));
  check(
    "URLSearchParams labelled form-urlencoded",
    String(r4.data.contentType).includes("x-www-form-urlencoded"),
    `CT=${r4.data.contentType}`,
  );
  check("URLSearchParams body intact", r4.data.text === "a=1&b=2", r4.data.text);

  // FormData with a File
  const fd = new FormData();
  fd.append("field", "value");
  fd.append("file", new File(["FILECONTENT"], "a.txt", { type: "text/plain" }), "a.txt");
  const r5 = await api.post("/upload", fd);
  check(
    "FormData uses multipart with boundary",
    String(r5.data.contentType).includes("multipart/form-data") &&
      String(r5.data.contentType).includes("boundary="),
    `CT=${r5.data.contentType}`,
  );
  check("FormData preserves file content", r5.data.text.includes("FILECONTENT"), r5.data.text.slice(0, 120));
  check("FormData preserves filename", r5.data.text.includes('filename="a.txt"'));

  // Explicit user Content-Type must win.
  const r6 = await api.post("/upload", new Uint8Array([1, 2]), {
    headers: { "Content-Type": "image/png" },
  });
  check("explicit Content-Type respected", r6.data.contentType === "image/png", `CT=${r6.data.contentType}`);

  // Plain JSON must still work.
  const r7 = await api.post("/upload", { hello: "world" });
  check(
    "JSON body still labelled application/json",
    String(r7.data.contentType).includes("application/json"),
    `CT=${r7.data.contentType}`,
  );
  check("JSON body serialized", r7.data.text === '{"hello":"world"}', r7.data.text);

  // Upload surviving a 401 → refresh → retry. Needs a seeded refresh token,
  // otherwise the client short-circuits (correctly) without attempting refresh.
  const authed = createClient({ baseUrl: BASE, worker: false, refreshSkewMs: 0 });
  await authed.setTokens({ accessToken: "old", refreshToken: "refresh-1" });
  const fd2 = new FormData();
  fd2.append("file", new File(["RETRYBODY"], "b.txt"), "b.txt");
  const r8 = await authed.post("/upload-401", fd2);
  check("FormData survives 401→refresh→retry", r8.status === true, `status=${r8.statusCode}`);
  check("retried FormData body not empty", r8.data?.byteLength > 0, `bytes=${r8.data?.byteLength}`);

  // ── 2. react-query integration ────────────────────────
  console.log("\n\x1b[1m@tanstack/query-core integration\x1b[0m");

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });

  const runQuery = (options) =>
    new Promise((resolve) => {
      const observer = new QueryObserver(qc, { queryKey: options.queryKey, queryFn: options.queryFn, retry: false });
      const unsub = observer.subscribe((res) => {
        if (res.status === "success" || res.status === "error") {
          unsub();
          resolve(res);
        }
      });
    });

  // Success path.
  const okQuery = await runQuery({
    queryKey: ["ok"],
    queryFn: () => api.get("/ok").then((r) => r.data),
  });
  check("successful query resolves", okQuery.status === "success" && okQuery.data.ok === true);

  // Documents the trap: without throwError the envelope resolves, so a 500
  // is cached as a successful result. This is why `throwError` exists.
  const naive = await runQuery({
    queryKey: ["boom-naive"],
    queryFn: () => api.get("/boom"),
  });
  check(
    "[documented] envelope-style 500 looks like SUCCESS to react-query",
    naive.status === "success",
    `expected the trap to reproduce, saw status="${naive.status}"`,
  );

  // With throwError.
  const withThrow = await runQuery({
    queryKey: ["boom-throw"],
    queryFn: () => api.get("/boom", { throwError: true }),
  });
  check(
    "500 marked as error when throwError:true",
    withThrow.status === "error",
    `status=${withThrow.status}`,
  );
  check(
    "error is an ApiError with statusCode",
    withThrow.error instanceof ApiError && withThrow.error.statusCode === 500,
    `error=${withThrow.error?.constructor?.name} code=${withThrow.error?.statusCode}`,
  );

  // Mutation path.
  const mutationResult = await new Promise((resolve) => {
    const observer = new MutationObserver(qc, {
      mutationFn: (vars) => api.post("/boom", vars, { throwError: true }),
      retry: false,
    });
    observer.subscribe((res) => {
      if (res.status === "success" || res.status === "error") resolve(res);
    });
    observer.mutate({ a: 1 }).catch(() => {});
  });
  check("failed mutation marked as error", mutationResult.status === "error", `status=${mutationResult.status}`);

  // Query cancellation: react-query passes an AbortSignal to queryFn.
  let sawSignal = false;
  await runQuery({
    queryKey: ["signal"],
    queryFn: ({ signal }) => {
      sawSignal = signal instanceof AbortSignal;
      return api.get("/ok", { signal }).then((r) => r.data);
    },
  });
  check("queryFn receives AbortSignal and client accepts it", sawSignal);

  // Does an aborted request reject (so react-query treats it as cancelled)?
  const ac = new AbortController();
  const abortPromise = api.get("/slow", { signal: ac.signal, throwError: true });
  setTimeout(() => ac.abort(), 50);
  let abortRejected = false;
  let abortSettled;
  try {
    abortSettled = await abortPromise;
  } catch {
    abortRejected = true;
  }
  check(
    "aborted request rejects with throwError:true",
    abortRejected,
    abortRejected ? "" : `resolved instead: statusCode=${abortSettled?.statusCode}`,
  );

  // ── 3. SWR integration ────────────────────────────────
  console.log("\n\x1b[1mSWR integration\x1b[0m");
  // SWR's core contract is identical: fetcher must REJECT for `error` to populate.
  let naiveSwrRejected = false;
  let naiveVal;
  try {
    naiveVal = await api.get("/notfound");
  } catch {
    naiveSwrRejected = true;
  }
  check(
    "[documented] envelope-style 404 resolves, so SWR fills `data` not `error`",
    !naiveSwrRejected && naiveVal?.status === false && naiveVal?.statusCode === 404,
    `expected the trap to reproduce (rejected=${naiveSwrRejected})`,
  );

  const swrFetcherThrow = () => api.get("/notfound", { throwError: true });
  let swrRejected = false;
  try {
    await swrFetcherThrow();
  } catch (e) {
    swrRejected = e instanceof ApiError;
  }
  check("SWR fetcher rejects on 404 with throwError:true", swrRejected);

  // ── 4. Client-wide throwError ─────────────────────────
  console.log("\n\x1b[1mclient-wide throwError\x1b[0m");
  const strict = createClient({ baseUrl: BASE, worker: false, refreshSkewMs: 0, throwError: true });

  let globalThrew = false;
  let globalErr;
  try {
    await strict.get("/boom");
  } catch (e) {
    globalThrew = true;
    globalErr = e;
  }
  check("client-level throwError rejects without per-call config", globalThrew);
  check(
    "rejection is ApiError with statusCode",
    globalErr instanceof ApiError && globalErr.statusCode === 500,
    `${globalErr?.constructor?.name}`,
  );

  // Success must still resolve normally.
  const strictOk = await strict.get("/ok");
  check("client-level throwError still resolves on success", strictOk.status === true);

  // A single call must be able to opt out.
  let optedOut = true;
  try {
    const r = await strict.get("/boom", { throwError: false });
    optedOut = r.status === false && r.statusCode === 500;
  } catch {
    optedOut = false;
  }
  check("per-request throwError:false overrides client default", optedOut);

  // The whole point: react-query with a plain fetcher and no per-call flags.
  const strictQuery = await runQuery({
    queryKey: ["strict-boom"],
    queryFn: () => strict.get("/boom").then((r) => r.data),
  });
  check(
    "react-query sees 500 as error with client-wide throwError",
    strictQuery.status === "error",
    `status=${strictQuery.status}`,
  );

  // And SWR.
  let strictSwr = false;
  try {
    await strict.get("/notfound");
  } catch (e) {
    strictSwr = e instanceof ApiError && e.statusCode === 404;
  }
  check("SWR fetcher rejects with client-wide throwError", strictSwr);
} finally {
  server.close();
}

console.log(`\n\x1b[1mresult\x1b[0m  ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\n\x1b[1mfailures\x1b[0m");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(0);
