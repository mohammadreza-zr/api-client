/**
 * `prepare` hook.
 *
 * `prepare` is the only lifecycle script npm runs for `npm link`, and it also
 * covers `npm pack`, `npm publish`, folder installs and git installs. Wiring
 * the build here means a consumer can never end up with a stale or missing
 * `dist/` — which is exactly what happened when the build was attached to
 * `prepublishOnly` (publish only) or `prepack` (everything except link).
 *
 * The catch: `prepare` ALSO runs on a plain `npm install` inside this repo,
 * including `npm ci --omit=dev`, where the build tools are not installed. A
 * naive `"prepare": "npm run build"` therefore hard-fails production installs
 * with `sh: tsx: not found`.
 *
 * So: build when the toolchain is present, and skip quietly when it isn't.
 * A consumer installing from a tarball already has a prebuilt `dist/` and
 * never needs this to run at all.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// tsup and tsx are what `npm run build` shells out to.
const toolchainPresent = ["tsup", "tsx"].every((tool) =>
  existsSync(join(root, "node_modules", tool)),
);

if (!toolchainPresent) {
  // Not an error: production installs legitimately have no devDependencies.
  console.log("prepare: build toolchain absent (production install) — skipping build");
  process.exit(0);
}

const result = spawnSync("npm", ["run", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
