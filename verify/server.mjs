/** Throwaway test server for verify/run.mjs. Not part of the package. */
import { createServer } from "node:http";

let accessSeq = 0;
const state = { refreshCalls: 0, protectedCalls: 0, validAccess: null, validRefresh: "refresh-1" };

function jwt(expSecondsFromNow) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256", typ: "JWT" })}.${b({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
}

const send = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((r) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        r(d ? JSON.parse(d) : {});
      } catch {
        r({ raw: d });
      }
    });
  });

export function start(port = 4599) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;
    const auth = req.headers.authorization;

    if (path === "/auth/login") {
      const body = await readBody(req);
      if (body.password !== "good") return send(res, 401, { message: "Bad credentials" });
      state.validAccess = jwt(60);
      accessSeq++;
      return send(res, 200, {
        data: { access: state.validAccess, refresh: state.validRefresh, user: { id: 1, name: "Ada" } },
        message: "ok",
      });
    }

    if (path === "/auth/refresh") {
      state.refreshCalls++;
      const body = await readBody(req);
      if (body.refresh !== state.validRefresh) return send(res, 401, { message: "Bad refresh" });
      await new Promise((r) => setTimeout(r, 60)); // window for stampede
      state.validAccess = jwt(60);
      accessSeq++;
      return send(res, 200, { data: { access: state.validAccess, refresh: state.validRefresh } });
    }

    if (path === "/auth/logout") return send(res, 200, { message: "bye" });

    if (path === "/protected") {
      state.protectedCalls++;
      if (auth !== `Bearer ${state.validAccess}`) return send(res, 401, { message: "Token expired" });
      return send(res, 200, { data: { ok: true, seq: accessSeq }, message: "" });
    }

    if (path === "/echo") {
      const body = await readBody(req);
      return send(res, 200, { data: { query: url.search, body, ct: req.headers["content-type"] ?? null } });
    }

    if (path === "/slow") {
      await new Promise((r) => setTimeout(r, 2000));
      return send(res, 200, { data: { slow: true } });
    }

    if (path === "/boom") return send(res, 500, { message: "Internal Server Error" });
    if (path === "/invalid") return send(res, 400, { message: "Invalid", errors: { name: ["required"] } });
    if (path === "/nocontent") {
      res.writeHead(204);
      return res.end();
    }
    if (path === "/text") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("plain hello");
    }

    send(res, 404, { message: "Not found" });
  });

  return new Promise((r) => server.listen(port, () => r({ server, state })));
}

export function expireAccess() {
  state.validAccess = "expired-now";
}
export { state };
