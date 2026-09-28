/** HTTP server for the regression suites and verify/tokens.mjs. Not part of the package. */
import { createServer } from "node:http";

export const FILE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xd8, 0x80]);

export const state = {
  seen: [],
  refreshMode: "ok",
  refreshCalls: 0,
  refreshBodies: [],
  refreshCsrf: [],
  loginBody: {},
  /** Rotation: each refresh token works once; a reuse revokes the family. */
  liveRefresh: new Set(),
  usedRefresh: new Set(),
  reuseDetected: false,
  rotation: 0,
};

export function jwt(expSecondsFromNow) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256" })}.${b({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
}

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({ raw: data });
      }
    });
  });

async function refresh(req, res) {
  state.refreshCalls++;
  const body = await readBody(req);
  state.refreshBodies.push(body);
  state.refreshCsrf.push(req.headers["x-csrf-token"] ?? null);

  if (state.refreshMode === "hang") return;
  if (state.refreshMode === "slow") await new Promise((r) => setTimeout(r, 300));
  if (state.refreshMode === "reject") return json(res, 401, { message: "Refresh rejected" });
  if (state.refreshMode === "down") return req.socket.destroy();
  if (state.refreshMode === "rotate") {
    if (!state.liveRefresh.has(body.refresh)) {
      if (state.usedRefresh.has(body.refresh)) state.reuseDetected = true;
      return json(res, 401, { message: "Refresh token reused" });
    }
    state.liveRefresh.delete(body.refresh);
    state.usedRefresh.add(body.refresh);
    await new Promise((r) => setTimeout(r, 80));
    const next = `rotated-${++state.rotation}`;
    state.liveRefresh.add(next);
    return json(res, 200, { access: jwt(600), refresh: next });
  }
  // `token` too, like servers that name it so: a leak via getSocketToken(refreshUrl) would show here.
  const access = jwt(600);
  return json(res, 200, { access, refresh: "refresh-next", token: access });
}

export function start(port) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;
    state.seen.push({
      path: req.url,
      method: req.method,
      auth: req.headers.authorization ?? null,
      csrf: req.headers["x-csrf-token"] ?? null,
      ct: req.headers["content-type"] ?? null,
    });

    if (path === "/auth/refresh") return refresh(req, res);
    if (path === "/auth/login") {
      await readBody(req);
      return json(res, 200, state.loginBody);
    }
    if (path === "/auth/logout") return json(res, 200, { message: "bye" });
    if (path === "/missing") return json(res, 404, { message: "Not found" });
    if (path === "/forbidden") return json(res, 403, { message: "Forbidden" });
    if (path === "/private") return json(res, 401, { message: "Unauthorized" });
    if (path.startsWith("/socket/")) {
      // A ticket is only issued to an authenticated caller.
      if (!req.headers.authorization?.startsWith("Bearer ")) return json(res, 401, { message: "Unauthorized" });
      if (path === "/socket/ticket") return json(res, 200, { ticket: `ticket-for-${req.method}` });
      if (path === "/socket/wrapped") return json(res, 200, { data: { token: "wrapped-token" } });
      if (path === "/socket/plain") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("plain-token");
      }
      return json(res, 200, { data: { ok: true } });
    }
    if (path === "/echo-auth-deep") {
      let nested = { seen: req.headers.authorization?.slice(7) ?? null };
      for (let i = 0; i < 20; i++) nested = { level: nested };
      return json(res, 200, { data: nested });
    }
    if (path === "/echo-auth") return json(res, 200, { data: { seen: req.headers.authorization?.slice(7) ?? null } });
    if (path === "/page") return json(res, 200, { data: [1, 2], meta: { total: 500 } });
    if (path === "/file") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return res.end(FILE_BYTES);
    }
    if (path === "/stall-body") {
      // Headers and half a body, then silence: only a timeout covering the body can end this.
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.write('{"partial":');
    }
    if (path === "/login-with-roles") {
      return json(res, 200, { access: jwt(600), refresh: "r", user: { name: "Ada", access: ["admin"] } });
    }
    json(res, 200, { data: { ok: true } });
  });

  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

/** The requests the server saw for one path. */
export const seenAt = (path) => state.seen.filter((entry) => entry.path.startsWith(path));
