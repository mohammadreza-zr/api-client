# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`@mrzr/api-client` is a zero-dependency, fetch-based TypeScript HTTP client whose focus is browser auth: coalesced token refresh, Web Worker token isolation, cross-tab session sync (BroadcastChannel), httpOnly cookie sessions, CSRF double-submit and opt-in cancellation. It is published to npm as ESM + CJS. Node >= 20.

## Commands

```bash
npm run build          # build:worker then build:bundle (order matters, see below)
npm run build:worker   # bundles src/worker/worker-entry.ts → inlines it into src/worker/worker-source.ts
npm run build:bundle   # tsup → dist/{index.js,index.cjs,index.d.ts,index.d.cts}
npm run dev            # tsup --watch (pair with `npm link` when testing in another project)
npm run lint           # eslint src scripts — must pass with zero warnings
npm run typecheck      # tsc --noEmit
npm test               # every verify/ suite except packaging, against the current dist/
npm run verify         # build + npm test + verify/package.mjs
```

There is no test framework. Tests are plain Node scripts in `verify/` that import from `../dist/index.js` (not `src/`), so **build before running one**:

```bash
npm run build && node verify/cancel.mjs     # run a single suite
```

Each suite starts its own real `node:http` server (`verify/server.mjs`, `verify/audit-server.mjs`) on a fixed port (4599–4610), uses a local `check(name, cond, detail)` helper and exits non-zero on failure. No mocked `fetch` — keep it that way.

- Worker-mode suites import `verify/worker-harness.mjs`, which runs the **shipped inlined worker bundle** (parsed out of `src/worker/worker-source.ts`) in a `node:vm` context behind a fake `Worker`. A stale worker build means these test stale code.
- `verify/regressions.mjs` / `regressions-worker.mjs` hold one reproduction per audit bug; the `test` script in `package.json` is the single list of suites (CI and release run it).
- `verify/package.mjs` packs a real tarball, installs it into a throwaway project and exercises `npm link`.
- Assertions labelled `[documented]` lock in surprising-but-intentional behaviour. Don't delete them.

## Architecture

**One request pipeline.** `executeRequest` in `src/internal/engine.ts` is the only request path. `CoreClient` (`src/internal/core-client.ts`) wires it to auth actions, refresh, storage, broadcast and cancellation. The worker (`src/worker/worker-entry.ts`) runs the same `CoreClient` inside the worker; the main thread talks to it through `WorkerHost` (`src/worker/worker-host.ts`) using the messages in `src/worker/protocol.ts`. Change behaviour in the engine or `CoreClient`, never in only one mode.

**Mode selection** happens in `createClient` (`src/client.ts`), which also resolves `baseUrl` (`resolveBaseUrl` in `env.ts`: option → env var → page origin) and the storage adapter (`storageFor`) before constructing `CoreClient`, so neither ships in the worker bundle. Worker mode is the default. It falls back to an inline `CoreClient` on the server, inside a worker, when `Worker` is missing, when the worker can't be constructed (for example because of CSP), or when `extractTokens`/`buildRefreshBody` are passed as **functions**, since functions can't be structured-cloned. Their declarative forms (`TokenFieldMap`, `RefreshBodyConfig`) keep worker mode. If the worker fails to boot (CSP blocks `blob:` asynchronously, or 10 s pass), `WorkerHost` switches to an in-page `CoreClient` and `isWorker` turns `false`; the transport lives in `worker/worker-channel.ts`. `client.ts` declares an `Implementation` type that both `WorkerHost` and `CoreClient` must satisfy, so the compiler catches a method added to only one of them. `wrap()` applies `throwError` / `throwOnCancel` semantics on top of either implementation.

**Worker build.** `src/worker/worker-source.ts` is AUTO-GENERATED and committed. `scripts/build-worker.ts` resets it to `""` first to avoid self-inlining, bundles the worker entry as a minified IIFE and writes it back as a string. If you change anything the worker imports, rebuild, or `dist` and the worker suites use a stale worker. The inlined worker ships even when `worker: false`, so keep an eye on its size.

**Crossing the worker boundary.** Anything sent to the worker must be structured-cloneable. Function options are either served from the host over the bridge (`storage` and CSRF: the worker sends `storage` / `csrf` messages and the host answers) or they force inline mode.

**Token trust.** The engine attaches `Authorization` and the CSRF header only when the final URL is relative or its origin is the `baseUrl` origin or in `authOrigins` (`internal/origin.ts`). Never attach credentials anywhere else.

**Refresh** (`src/internal/refresh.ts`) coalesces concurrent 401s onto one shared promise (`AuthStore.coalesceRefresh`), runs under a cross-tab Web Lock, adopts a sibling tab's fresh tokens instead of re-spending a rotating refresh token, has the client timeout, and sends CSRF. `AuthStore.generation` bumps on logout/login/`setTokens`; a refresh that started under an older generation must not write back. Only an auth rejection (401/403) from the refresh endpoint clears the session. 5xx, timeouts and network failures leave it intact. Test refresh changes with N concurrent 401s, not one.

**Public surface.** Everything exported lives in `src/index.ts`. Public types and `ApiError` live in `src/types.ts` with TSDoc (it shows up in editors).

## Conventions

- No runtime dependencies.
- Comments explain *why*. Existing comments document non-obvious decisions, so read them before changing the code they guard.
- Catches that swallow errors (storage failures, listener exceptions, closed channels) do so on purpose. Don't turn them into throws.
- Detect features (`typeof X !== "undefined"`) instead of sniffing the user agent.
- Body handling must keep exact bytes. `verify/audit.mjs` asserts them for every body type.
- When adding a feature: implement it in the engine or `CoreClient`, add types in `src/types.ts`, export from `src/index.ts`, add assertions to the relevant suite **and** to `verify/worker.mjs` (worker parity), and update the matching `wiki/` page plus `Client-Options.md` / `Request-Config.md`.
- `wiki/` is mirrored to the GitHub Wiki (`npm run docs:sync`). Filenames use hyphens for spaces, `[[Page Name]]` links resolve, and `_Sidebar.md` must list new pages. `wiki/Contributing.md` is the long-form contributor guide.
- User-facing changes go in `CHANGELOG.md`.

## Build and release

- `prepare` runs `scripts/prepare.mjs`, which builds whenever the toolchain is installed (it covers `npm link`, pack, publish and folder installs) and skips quietly on `--omit=dev` installs.
- CI (`.github/workflows/ci.yml`) runs lint, typecheck, build and the suites on Node 20/22/24, plus `@arethetypeswrong/cli --pack .` and `npm pack --dry-run`.
- Releases: `npm version patch|minor|major && git push --follow-tags`. `release.yml` checks that the tag matches `package.json` and publishes with provenance through npm trusted publishing (OIDC, no `NPM_TOKEN`). Don't change `repository.url`, because provenance depends on it.
