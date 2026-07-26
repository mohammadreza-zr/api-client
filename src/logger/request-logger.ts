import { isServer } from "../utils/helpers";

export interface LogPayload {
  url: string;
  method: string;
  statusCode: number;
  status: boolean;
  message: string;
  queryString?: string;
  duration?: number;
  error?: unknown;
}

export function logRequest(payload: LogPayload): void {
  const line = JSON.stringify(
    { ...payload, timestamp: new Date().toISOString() },
    null,
    2,
  );

  if (!isServer()) {
    console.info("[api-client]", line);
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.resolve(".next");
    const file = path.join(dir, "api.log");

    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, line + "\n---\n");
  } catch {
    console.info("[api-client]", line);
  }
}