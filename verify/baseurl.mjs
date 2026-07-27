/**
 * Regression suite for `baseUrl` auto-detection.
 *
 * The bug: detection only ever looked at `process.env[key]` (a *dynamic*
 * index) and `globalThis.__VITE_ENV__`. Bundlers inline env vars by textually
 * replacing `process.env.NEXT_PUBLIC_API_URL` / `import.meta.env.VITE_API_URL`,
 * which a dynamic index defeats — and in a browser bundle `process` does not
 * exist at all. So in every real app `baseUrl` silently resolved to `""` and
 * relative URLs hit the page origin instead of the API.
 *
 * These checks exercise the shipped `dist/` bundles, not the source.
 */
import { readFileSync } from "node:fs";
import { start } from "./server.mjs";

const BASE = "http://localhost:4601";
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

const ENV_KEYS = [
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_BASE_URL",
  "VITE_API_URL",
  "VITE_BASE_URL",
  "NUXT_PUBLIC_API_URL",
  "PUBLIC_API_URL",
  "API_URL",
];

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
  delete globalThis.__VITE_ENV__;
  delete globalThis.__ENV__;
  delete globalThis.ENV;
  delete globalThis.__API_BASE_URL__;
}

const { server } = await start(4601);
const { createClient } = await import("../dist/index.js");

/** Detection happens in the constructor, so each case needs a fresh client. */
async function resolvedBaseUrl(options = {}) {
  const api = createClient({ worker: false, multiTab: false, throwError: false, ...options });
  const res = await api.get("/echo");
  api.destroy();
  return res.status ? BASE : null;
}

try {
  console.log("\nprocess.env detection (Node / Next server / SSR)");

  for (const key of ENV_KEYS) {
    clearEnv();
    process.env[key] = BASE;
    check(`${key} is picked up`, (await resolvedBaseUrl()) === BASE);
  }

  console.log("\nprecedence");

  clearEnv();
  process.env.API_URL = "http://127.0.0.1:9/wrong";
  process.env.NEXT_PUBLIC_API_URL = BASE;
  check("NEXT_PUBLIC_API_URL wins over API_URL", (await resolvedBaseUrl()) === BASE);

  clearEnv();
  process.env.VITE_BASE_URL = "http://127.0.0.1:9/wrong";
  process.env.VITE_API_URL = BASE;
  check("VITE_API_URL wins over VITE_BASE_URL", (await resolvedBaseUrl()) === BASE);

  clearEnv();
  process.env.NEXT_PUBLIC_API_URL = "";
  process.env.VITE_API_URL = BASE;
  check("an empty string does not shadow a later key", (await resolvedBaseUrl()) === BASE);

  clearEnv();
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:9/wrong";
  check("explicit baseUrl beats every env var", (await resolvedBaseUrl({ baseUrl: BASE })) === BASE);

  console.log("\ninjected env bags (bundler / runtime-config style)");

  clearEnv();
  globalThis.__VITE_ENV__ = { VITE_API_URL: BASE };
  check("globalThis.__VITE_ENV__ still supported", (await resolvedBaseUrl()) === BASE);

  clearEnv();
  globalThis.__ENV__ = { NEXT_PUBLIC_API_URL: BASE };
  check("globalThis.__ENV__ supported", (await resolvedBaseUrl()) === BASE);

  clearEnv();
  globalThis.__API_BASE_URL__ = BASE;
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:9/wrong";
  check("globalThis.__API_BASE_URL__ overrides everything", (await resolvedBaseUrl()) === BASE);

  console.log("\nno configuration at all");

  clearEnv();
  const bare = createClient({ worker: false, multiTab: false, throwError: false });
  const relative = await bare.get("/echo");
  check("relative URL with no baseUrl fails instead of hanging", relative.status === false);
  const absolute = await bare.get(`${BASE}/echo`);
  check("absolute URLs work with no baseUrl", absolute.status === true);
  bare.destroy();

  console.log("\ntrailing slashes");

  clearEnv();
  process.env.NEXT_PUBLIC_API_URL = `${BASE}///`;
  check("trailing slashes normalized", (await resolvedBaseUrl()) === BASE);

  /*
   * Static shape of the shipped bundles.
   *
   * Node cannot exercise a webpack/Vite build, and that is precisely where the
   * bug lived. Those bundlers inline env vars by replacing the literal text
   * `process.env.NEXT_PUBLIC_API_URL` / `import.meta.env.VITE_API_URL`. If the
   * bundle only ever indexes dynamically (`env[key]`), the replacement pass
   * finds nothing and browser builds always get "". So assert the literals are
   * actually present in dist.
   */
  console.log("\nshipped bundle is statically replaceable");

  const esm = readFileSync("dist/index.js", "utf8");
  const cjs = readFileSync("dist/index.cjs", "utf8");

  for (const key of ENV_KEYS) {
    check(`ESM contains literal process.env.${key}`, esm.includes(`process.env.${key}`));
  }
  check(
    "ESM contains literal import.meta.env.VITE_API_URL",
    esm.includes("import.meta.env.VITE_API_URL"),
  );
  // Only the *static* reads must keep an unbroken chain; the dynamic bag in
  // `dynamicBags()` intentionally uses `import.meta?.env` and is not a target
  // for textual replacement.
  check(
    "static import.meta.env reads keep the chain unbroken (?. defeats define)",
    ENV_KEYS.every((key) => !esm.includes(`import.meta?.env.${key}`) && !esm.includes(`import.meta.env?.${key}`)),
  );
  // Comments are stripped from the comparison: only real code matters here.
  const cjsCode = cjs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("CJS never emits import.meta (syntax error in CJS)", !/[^.\w]import\.meta/.test(cjsCode));
  check(`CJS still reads process.env literally`, cjs.includes("process.env.NEXT_PUBLIC_API_URL"));
} catch (e) {
  fail++;
  console.error("\nUNEXPECTED:", e);
} finally {
  clearEnv();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
