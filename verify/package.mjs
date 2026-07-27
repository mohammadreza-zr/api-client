/**
 * Verifies the PUBLISHED ARTIFACT, not the working tree.
 *
 * Every other suite imports `dist/`, which is whatever was built last. That
 * cannot catch a packaging fault: if the tarball ships stale or missing code,
 * consumers hit bugs that are already fixed in source.
 *
 * That happened. `prepublishOnly` does not run for `npm pack` (or for
 * `npm install <folder>` / git installs), so packing without a manual build
 * produced a tarball containing no `dist/` at all — just README and
 * package.json — or, worse, a silently stale one.
 *
 * This suite packs the real tarball, installs it into a throwaway consumer
 * project, and asserts the installed code both resolves and behaves.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const work = mkdtempSync(join(tmpdir(), "apiclient-pack-"));
const consumer = join(work, "consumer");

try {
  console.log("\npacking");

  // Pack from a pristine tree: no dist/, exactly like a fresh clone + pack.
  // If `prepack` is missing or broken, the tarball comes out empty.
  rmSync("dist", { recursive: true, force: true });
  check("dist/ removed before packing", !existsSync("dist"));

  const packed = run("npm", ["pack", "--pack-destination", work], process.cwd()).trim().split("\n").pop();
  const tarball = join(work, packed);
  check("npm pack produced a tarball", existsSync(tarball), packed);

  check(
    "prepack rebuilt dist/ automatically (prepublishOnly does NOT run for pack)",
    existsSync("dist/index.js"),
  );

  console.log("\ntarball contents");

  const listing = run("tar", ["-tzf", tarball], work);
  const entries = listing.split("\n").filter(Boolean).map((l) => l.replace(/^package\//, ""));

  for (const required of [
    "dist/index.js",
    "dist/index.cjs",
    "dist/index.d.ts",
    "dist/index.d.cts",
    "package.json",
    "README.md",
    "LICENSE",
  ]) {
    check(`ships ${required}`, entries.includes(required), entries.join(" "));
  }

  check("does not ship src/", !entries.some((e) => e.startsWith("src/")));
  check("does not ship verify/", !entries.some((e) => e.startsWith("verify/")));

  console.log("\ninstalling into a clean consumer project");

  run("mkdir", ["-p", consumer], work);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", version: "1.0.0", type: "module", private: true }, null, 2),
  );
  run("npm", ["install", "--no-audit", "--no-fund", tarball], consumer);

  const installed = join(consumer, "node_modules/@mrzr/api-client");
  check("package installed", existsSync(installed));
  check(
    "installed dist/ is populated",
    existsSync(join(installed, "dist/index.js")),
    readdirSync(installed).join(" "),
  );

  console.log("\nthe installed build contains the fixes");

  const esm = readFileSync(join(installed, "dist/index.js"), "utf8");
  const cjs = readFileSync(join(installed, "dist/index.cjs"), "utf8");

  // Guards against shipping a stale dist/ built before these landed.
  check("storage bridge present (worker persistence)", esm.includes("storageResult"));
  check("worker-scope detection present (cross-tab sync)", esm.includes("importScripts"));
  check("static baseUrl reads present", esm.includes("process.env.NEXT_PUBLIC_API_URL"));
  check("CJS build has them too", cjs.includes("storageResult") && cjs.includes("importScripts"));

  console.log("\nboth entry points resolve as a real consumer");

  const esmProbe = join(consumer, "probe.mjs");
  writeFileSync(
    esmProbe,
    `import { createClient, detectBaseUrl } from "@mrzr/api-client";
     const api = createClient({ baseUrl: "http://x", worker: false, multiTab: false });
     console.log(JSON.stringify({ ok: typeof api.get === "function", base: typeof detectBaseUrl() }));
     api.destroy();`,
  );
  const esmOut = JSON.parse(run("node", [esmProbe], consumer).trim());
  check("ESM import works via the package name", esmOut.ok === true);
  check("named utility exports resolve", esmOut.base === "string");

  const cjsProbe = join(consumer, "probe.cjs");
  writeFileSync(
    cjsProbe,
    `const { createClient } = require("@mrzr/api-client");
     const api = createClient({ baseUrl: "http://x", worker: false, multiTab: false });
     console.log(JSON.stringify({ ok: typeof api.post === "function" }));
     api.destroy();`,
  );
  check("CJS require works via the package name", JSON.parse(run("node", [cjsProbe], consumer).trim()).ok === true);

  const dts = readFileSync(join(installed, "dist/index.d.ts"), "utf8");
  check("types declare createClient", /declare function createClient/.test(dts));
  check("types declare ClientOptions.storage", /storage\?:/.test(dts));

  console.log("\nthe installed build actually persists tokens");

  /*
   * The probe runs in a child process, and `execFileSync` blocks this one's
   * event loop — so an in-process server could never answer it. The child
   * therefore starts its own server and talks to itself.
   */
  const behaviourProbe = join(consumer, "behaviour.mjs");
  writeFileSync(
    behaviourProbe,
    `import { createServer } from "node:http";
     const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
     const token = () => b64({ alg: "HS256" }) + "." + b64({ exp: Math.floor(Date.now() / 1000) + 60 }) + ".sig";
     const server = createServer(async (req, res) => {
       for await (const _ of req) { /* drain */ }
       res.writeHead(200, { "Content-Type": "application/json" });
       res.end(JSON.stringify({ data: { access: token(), refresh: "r-1" } }));
     });
     await new Promise((r) => server.listen(0, "127.0.0.1", r));
     const port = server.address().port;

     const disk = new Map();
     globalThis.localStorage = {
       getItem: (k) => (disk.has(k) ? disk.get(k) : null),
       setItem: (k, v) => disk.set(k, String(v)),
       removeItem: (k) => disk.delete(k),
     };
     const { createClient } = await import("@mrzr/api-client");
     const mk = () => createClient({
       baseUrl: "http://127.0.0.1:" + port, storage: "local",
       worker: false, multiTab: false, throwError: false,
     });
     const a = mk();
     await a.login({ password: "good" });
     const wrote = disk.size > 0;
     a.destroy();
     const b = mk();
     await new Promise((r) => setTimeout(r, 50));
     const survives = (await b.getAuthState()).isAuthenticated;
     b.destroy();
     server.close();
     console.log(JSON.stringify({ wrote, survives }));`,
  );

  const behaviour = JSON.parse(run("node", [behaviourProbe], consumer).trim());
  check("installed build writes tokens to storage", behaviour.wrote === true);
  check("installed build restores the session after a reload", behaviour.survives === true);
} catch (e) {
  fail++;
  console.error("\nUNEXPECTED:", e.message);
  if (e.stdout) console.error(String(e.stdout).slice(0, 800));
  if (e.stderr) console.error(String(e.stderr).slice(0, 800));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
