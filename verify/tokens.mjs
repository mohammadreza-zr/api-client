/**
 * Handing credentials to WebSockets / socket.io: `getSocketToken()` and the
 * opt-in `getAccessToken()`, in worker mode and main-thread mode alike.
 */
import "./worker-harness.mjs";
import { jwt, start, state } from "./regressions-server.mjs";

const BASE = "http://localhost:4624";
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
const rejection = (promise) => promise.then(() => undefined, (error) => error);

const server = await start(4624);
const { createClient, ApiError } = await import("../dist/index.js");

try {
  for (const worker of [true, false]) {
    const mode = worker ? "worker" : "main thread";
    const client = (options = {}) => createClient({ baseUrl: BASE, worker, multiTab: false, ...options });
    console.log(`\n[${mode}] getSocketToken`);

    const api = client();
    check(`${mode}: runs in the expected mode`, api.isWorker === worker);
    const anonymous = await rejection(api.getSocketToken("/socket/ticket"));
    check(`${mode}: an unauthenticated ticket request rejects with ApiError`, anonymous instanceof ApiError && anonymous.statusCode === 401);

    await api.setTokens({ accessToken: jwt(600), refreshToken: "r" });
    check(`${mode}: { ticket } via POST by default`, (await api.getSocketToken("/socket/ticket")) === "ticket-for-POST");
    check(`${mode}: method GET`, (await api.getSocketToken("/socket/ticket", { method: "GET" })) === "ticket-for-GET");
    check(`${mode}: { data: { token } }`, (await api.getSocketToken("/socket/wrapped")) === "wrapped-token");
    check(`${mode}: a plain-text token`, (await api.getSocketToken("/socket/plain")) === "plain-token");
    const empty = await rejection(api.getSocketToken("/socket/nothing"));
    check(`${mode}: a response without a token rejects clearly`, empty instanceof ApiError && /No socket token/.test(empty.message));

    console.log(`\n[${mode}] getAccessToken`);
    const refused = await rejection(api.getAccessToken());
    check(`${mode}: refused without exposeTokens`, /exposeTokens: true/.test(refused?.message ?? ""), refused?.message);

    const exposed = client({ exposeTokens: true });
    const live = jwt(600);
    await exposed.setTokens({ accessToken: live, refreshToken: "r" });
    check(`${mode}: returns the access token when opted in`, (await exposed.getAccessToken()) === live);

    state.refreshMode = "ok";
    const expiring = jwt(5);
    await exposed.setTokens({ accessToken: expiring, refreshToken: "r" });
    const fresh = await exposed.getAccessToken();
    check(`${mode}: an expiring token is refreshed before it is returned`, typeof fresh === "string" && fresh !== expiring);

    await exposed.setTokens({ accessToken: undefined, refreshToken: undefined });
    check(`${mode}: no session → undefined`, (await exposed.getAccessToken()) === undefined);

    const cookie = client({ authMode: "cookie", exposeTokens: true });
    check(`${mode}: cookie mode → undefined (httpOnly)`, (await cookie.getAccessToken()) === undefined);

    [api, exposed, cookie].forEach((instance) => instance.destroy());
  }
} finally {
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
