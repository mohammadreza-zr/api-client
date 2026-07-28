/** Throwaway audit server: upload + integration probes. Not part of the package. */
import { createServer } from "node:http";

const state = { lastCT: null, lastLen: 0, lastRaw: null, calls: 0, unauthorizedFirst: true, slowHits: 0 };

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const readRaw = (req) =>
  new Promise((r) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => r(Buffer.concat(chunks)));
  });

export function start(port = 4610) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;

    if (path === "/auth/refresh") {
      return json(res, 200, { data: { access: "new-access", refresh: "refresh-1" } });
    }

    // Records exactly what hit the wire.
    if (path === "/upload") {
      const raw = await readRaw(req);
      state.calls++;
      state.lastCT = req.headers["content-type"] ?? null;
      state.lastLen = raw.length;
      state.lastRaw = raw;
      return json(res, 200, {
        data: {
          contentType: req.headers["content-type"] ?? null,
          byteLength: raw.length,
          firstBytes: [...raw.subarray(0, 8)],
          text: raw.subarray(0, 400).toString("utf8"),
        },
      });
    }

    // 401 once, then 200 — exercises refresh+retry with a body.
    if (path === "/upload-401") {
      const raw = await readRaw(req);
      if (state.unauthorizedFirst) {
        state.unauthorizedFirst = false;
        return json(res, 401, { message: "expired" });
      }
      return json(res, 200, {
        data: { byteLength: raw.length, contentType: req.headers["content-type"] ?? null },
      });
    }

    if (path === "/ok") return json(res, 200, { data: { ok: true } });
    if (path === "/boom") return json(res, 500, { message: "Internal Server Error" });
    if (path === "/notfound") return json(res, 404, { message: "Nope" });
    if (path === "/slow") {
      // Counted so a test can prove a cancel was not retried by the caller.
      state.slowHits++;
      await new Promise((r) => setTimeout(r, 3000));
      return json(res, 200, { data: { slow: true } });
    }

    // Fails twice then succeeds — for retry probes.
    if (path === "/flaky") {
      state.calls++;
      if (state.calls < 3) return json(res, 500, { message: "flaky" });
      return json(res, 200, { data: { attempts: state.calls } });
    }

    json(res, 404, { message: "Not found" });
  });

  return new Promise((r) => server.listen(port, () => r({ server, state })));
}

export { state };
