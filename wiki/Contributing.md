# Contributing

```bash
git clone https://github.com/mohammadreza-zr/api-client.git
cd api-client
npm install
npm run verify   # build + run all four suites
```

---

## Repository layout

```
src/
  index.ts                  public exports — the entire API surface
  client.ts                 createClient(); picks worker vs. main thread; applies throwError
  types.ts                  the public type surface + ApiError
  internal/
    core-client.ts          the full client: auth actions, refresh, engine wiring
    engine.ts               executeRequest() — the one request pipeline
    auth-store.ts           token state, expiry, refresh coalescing, subscribers
    broadcast.ts            BroadcastChannel tab sync + leader election
    storage.ts              Memory/Web/Cookie adapters + resolveStorage
    extract.ts              default token & user extractors
    jwt.ts                  base64url decode, exp reading
    url.ts                  buildQueryString, templates, joining
    env.ts                  capability detection, baseUrl discovery
  worker/
    worker-entry.ts         the worker's message loop
    worker-host.ts          the main-thread proxy
    worker-source.ts        AUTO-GENERATED — the inlined worker bundle
    protocol.ts             the message types
scripts/
  build-worker.ts           bundles worker-entry into worker-source.ts
verify/
  run.mjs                   core engine suite      (39 assertions)
  worker.mjs                worker parity suite    (29 assertions)
  audit.mjs                 uploads + React Query  (31 assertions)
  features.mjs              throwError, uploads, CSRF (22 assertions)
  server.mjs                the test HTTP server
  audit-server.mjs          the upload-inspection server
wiki/                       this documentation
```

---

## The architectural invariant

**There is exactly one request pipeline: `executeRequest` in `src/internal/engine.ts`.**

The worker and the main thread both run `CoreClient`, which calls that engine. The worker path is built by inlining the *same* source. This is what makes worker mode and main-thread mode impossible to drift apart.

`src/client.ts` declares this explicitly:

```ts
type Implementation = Pick<ApiClient, "get" | "post" | … | "destroy">;
```

Both `WorkerHost` and `CoreClient` must satisfy it, so the compiler rejects a method added to one and not the other.

**When you change behaviour, change it in the engine, not in a mode.**

---

## Build pipeline

```bash
npm run build:worker   # tsup → IIFE → inlined into src/worker/worker-source.ts
npm run build:bundle   # tsup → dist/{index.js,index.cjs,index.d.ts,index.d.cts}
npm run build          # both, in order
```

Order matters: the worker must be inlined before the main bundle is built, or `dist` ships a stale worker. `scripts/build-worker.ts` guards against self-inlining by resetting `WORKER_SOURCE = ""` before bundling.

`prepublishOnly` runs `npm run build`, so a publish can never ship a stale `dist`.

---

## Verification

```bash
npm run verify
```

Four suites, **121 assertions**, all against real `node:http` servers — no mocked `fetch`, because the whole point is verifying real network behaviour.

| Suite | Covers |
|---|---|
| `run.mjs` | URL building, params, timeouts, aborts, refresh coalescing, storage, errors |
| `worker.mjs` | Worker parity — every core behaviour re-asserted in worker mode |
| `audit.mjs` | Upload byte integrity, content types, `@tanstack/query-core` and SWR integration |
| `features.mjs` | `throwError` semantics, `uploadSkewMs`, stream retry, CSRF double-submit |

Some assertions are labelled `[documented]` — they lock in behaviour that is surprising but intentional, such as *"an envelope-style 500 looks like SUCCESS to react-query"*. Don't delete them; they're the argument for the current defaults.

### Adding a test

```js
check("descriptive name", actual === expected, `got ${actual}`);
```

Add assertions to the suite that matches the area. If you change core behaviour, add a matching assertion to `worker.mjs` too — parity is the invariant.

---

## Code standards

```bash
npm run lint       # eslint src scripts
npm run typecheck  # tsc --noEmit
```

Both must pass with zero warnings before a PR.

TypeScript is configured strictly: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.

House style:

- **No runtime dependencies.** Ever. A PR adding one needs an extraordinary justification.
- **Comments explain *why*, not *what*.** The existing comments document non-obvious decisions — read them before changing the code they guard.
- **Every catch swallows deliberately.** Storage failures, listener exceptions and closed channels are non-fatal by design. Don't turn them into throws.
- **Public types live in `src/types.ts`** and are documented with TSDoc, which is what surfaces in editors.
- **Feature detect, don't sniff.** `typeof X !== "undefined"`, never a user-agent check.

---

## Adding a feature

1. Discuss it in an issue first, especially anything touching the public surface.
2. Implement it in the **engine** or `CoreClient`, not in a mode-specific path.
3. Add types to `src/types.ts` with TSDoc.
4. Export anything new from `src/index.ts`.
5. Add assertions to the relevant `verify/` suite **and** to `worker.mjs`.
6. Update the wiki page it belongs to, plus [[Client Options]] or [[Request Config]].
7. Run `npm run verify && npm run lint && npm run typecheck`.

### Things that need extra care

**Anything crossing the worker boundary** must be structured-cloneable. Functions, `ReadableStream`s and class instances are not. If your option is a function, either handle it on the host (like `getCsrfToken`) or add it to the list that disables worker mode (like `extractTokens`).

**Anything touching refresh** must preserve coalescing. Test it with N concurrent 401s, not one.

**Anything touching bodies** must preserve byte integrity. `audit.mjs` asserts exact bytes for every body type; extend it if you add another.

---

## CI

`.github/ci.yml.example` holds the workflow. It isn't committed to `.github/workflows/` because the GitHub App in use lacks the `workflows` permission — rename it locally to enable:

```bash
mkdir -p .github/workflows
cp .github/ci.yml.example .github/workflows/ci.yml
```

---

## Releasing

```bash
npm run verify              # all suites green
npm version patch|minor|major
npm publish                 # prepublishOnly rebuilds automatically
git push --follow-tags
```

Pre-publish checks worth running:

```bash
npm pack --dry-run                          # inspect the tarball contents
npx @arethetypeswrong/cli --pack .          # verify type resolution in every module mode
```

`files` is restricted to `dist`, `README.md` and `LICENSE`, so sources, tests and the wiki stay out of the tarball.

---

## Documentation

The wiki lives in `wiki/` and is mirrored to the GitHub Wiki. Page filenames map to wiki page names with hyphens for spaces (`Token-Refresh.md` → *Token Refresh*), and `[[Wiki Link]]` syntax resolves automatically.

Sync it:

```bash
./scripts/sync-wiki.sh
```

Keep `_Sidebar.md` in step when you add a page.

---

## Reporting bugs

Include the package version, runtime and framework, your `createClient` options with secrets removed, the failing call, the full `IRes` or `ApiError`, and `api.isWorker`. A reproduction against `https://httpbin.org` is ideal.

## Security issues

Open a [security advisory](https://github.com/mohammadreza-zr/api-client/security/advisories/new) rather than a public issue.
