/**
 * The plugin API and the services plugin, in worker mode and main-thread mode.
 * Plugins run on the page around each call, so both modes must behave alike.
 */
import "./worker-harness.mjs";
import { jwt, seenAt, start, state } from "./regressions-server.mjs";
import { createChecker, rejection, within } from "./check.mjs";

const BASE = "http://localhost:4625";
const FILES = "http://127.0.0.1:4626";
const PARTNER = "http://127.0.0.1:4627";
const { check, finish } = createChecker();

const servers = [await start(4625), await start(4626), await start(4627)];
const { createClient } = await import("../dist/index.js");
const { services } = await import("../dist/services.js");

const trace = (label) => ({
  name: `trace-${label}`,
  beforeRequest: (request) => ({
    ...request,
    config: { ...request.config, headers: { ...request.config?.headers, "X-Trace": `${request.config?.headers?.["X-Trace"] ?? ""}${label}` } },
  }),
});

try {
  for (const worker of [true, false]) {
    const mode = worker ? "worker" : "main thread";
    const client = (options = {}) =>
      createClient({ baseUrl: BASE, worker, multiTab: false, throwError: false, ...options });

    console.log(`\n[${mode}] plugin hooks`);
    const api = client({
      plugins: [
        trace("a"),
        trace("b"),
        { name: "tenant", configure: (options) => ({ ...options, headers: { ...options.headers, "X-Tenant": "acme" } }) },
        { name: "shape", afterResponse: (result) => ({ ...result, data: { wrapped: result.data } }) },
        { name: "hello", extend: (instance) => ({ hello: () => `hello from ${instance.isWorker ? "worker" : "page"}` }) },
      ],
    });
    check(`${mode}: plugins keep the chosen mode`, api.isWorker === worker);
    const traced = await api.get(`/plugins-${mode.length}`);
    const seen = seenAt(`/plugins-${mode.length}`)[0];
    check(`${mode}: beforeRequest runs, in order`, seen?.trace === "ab", seen?.trace);
    check(`${mode}: configure changes the client options`, seen?.tenant === "acme");
    check(`${mode}: afterResponse reshapes the result`, traced.data?.wrapped?.ok === true, JSON.stringify(traced.data));
    check(`${mode}: extend adds methods`, api.hello() === `hello from ${worker ? "worker" : "page"}`);

    console.log(`\n[${mode}] a failing plugin fails one call, never the client`);
    let explode = true;
    const fragile = client({
      plugins: [
        { name: "flaky-before", beforeRequest: (request) => { if (explode) throw new Error("boom"); return request; } },
      ],
    });
    const failed = await fragile.get("/flaky");
    check(`${mode}: a throwing beforeRequest fails that call and names the plugin`, failed.status === false && /flaky-before/.test(failed.message), failed.message);
    explode = false;
    check(`${mode}: the next call works`, (await fragile.get("/flaky")).status === true);
    const broken = await client({ plugins: [{ name: "flaky-after", afterResponse: () => { throw new Error("boom"); } }] }).get("/flaky");
    check(`${mode}: a throwing afterResponse keeps the HTTP status`, broken.status === false && broken.statusCode === 200 && /flaky-after/.test(broken.message));
    const clash = await rejection(Promise.resolve().then(() => client({ plugins: [{ name: "evil", extend: () => ({ get: () => "hijacked" }) }] })));
    check(`${mode}: a plugin cannot replace a built-in method`, /cannot replace api.get/.test(clash?.message ?? ""), clash?.message);

    console.log(`\n[${mode}] services`);
    const multi = client({
      getCsrfToken: () => "csrf-1",
      plugins: [
        services({
          files: { baseUrl: FILES, headers: { "X-Tenant": "files-tenant" }, timeout: 300 },
          partner: { baseUrl: `${PARTNER}/partner`, auth: false },
        }),
      ],
    });
    await multi.setTokens({ accessToken: jwt(600), refreshToken: "r" });
    const files = multi.service("files");
    await files.post(`/svc-${mode.length}`, {});
    const toFiles = seenAt(`/svc-${mode.length}`)[0];
    check(`${mode}: a declared service gets the token and CSRF`, toFiles?.auth?.startsWith("Bearer ") && toFiles?.csrf === "csrf-1", JSON.stringify(toFiles));
    check(`${mode}: service headers are sent`, toFiles?.tenant === "files-tenant");
    await files.get(`/svc-own-${mode.length}`, { headers: { "X-Tenant": "per-call" } });
    check(`${mode}: a call's own headers win`, seenAt(`/svc-own-${mode.length}`)[0]?.tenant === "per-call");
    const stalled = await within(files.get("/stall-body"), 3000);
    check(`${mode}: the service timeout applies`, stalled?.statusCode === 408, JSON.stringify(stalled?.statusCode));
    await multi.service("partner").post(`/svc-partner-${mode.length}`, {});
    const toPartner = seenAt(`/partner/svc-partner-${mode.length}`)[0];
    check(`${mode}: an auth:false service gets neither token nor CSRF`, toPartner && toPartner.auth === null && toPartner.csrf === null, JSON.stringify(toPartner));
    check(`${mode}: the default baseUrl still works`, (await multi.get("/svc-default")).status === true);
    const unknown = await rejection(Promise.resolve().then(() => multi.service("nope")));
    check(`${mode}: an unknown service names the declared ones`, /Unknown service "nope". Declared: files, partner/.test(unknown?.message ?? ""));

    [api, fragile, multi].forEach((instance) => instance.destroy());
  }

  console.log("\nsetup errors");
  const missing = await rejection(Promise.resolve().then(() => services({ search: { baseUrl: undefined } })));
  check("a service whose env variable is unset fails at setup", /Service "search" has no baseUrl/.test(missing?.message ?? ""));
  state.refreshMode = "ok";
} finally {
  servers.forEach((server) => server.close());
  finish();
}
