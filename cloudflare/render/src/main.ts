/**
 * Entrypoint: validate the environment, serve the control surface on
 * CONTAINER_PORT, start polling at once (a container is only ever started because
 * work was queued), and on SIGTERM stop asking for work, let jobs in flight
 * report (bounded), and exit.
 */
import { createServer } from "node:http";

import { RenderApi } from "./api.ts";
import { CONTAINER_PORT, readConfig } from "./config.ts";
import { handleControl } from "./control.ts";
import { jsonLog } from "./log.ts";
import { RenderWorker } from "./worker.ts";

const EX_CONFIG = 78;
// SIGTERM comes from the Durable Object only when /healthz said idle, or from a
// rollout. A job still running gets this long to report; after that its lease
// expiry hands the job to the next attempt.
const SHUTDOWN_GRACE_MS = 120_000;

const read = readConfig(process.env);
if (!read.ok) {
  jsonLog("error", "config_invalid", { invalid: read.invalid });
  process.exit(EX_CONFIG);
}
const { config } = read;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const worker = new RenderWorker({
  api: new RenderApi({ apiUrl: config.apiUrl, fetch, sleep, token: config.token }),
  fetch,
  idleExitMs: config.idleExitMs,
  log: jsonLog,
  maxConcurrentJobs: config.maxConcurrentJobs,
  sleep,
});

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://container").pathname;
  const { body, status } = handleControl(request.method ?? "GET", path, worker);
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" });
  response.end(JSON.stringify(body));
});

server.listen(CONTAINER_PORT, "0.0.0.0", () => {
  jsonLog("info", "container_started", {
    idleExitMs: config.idleExitMs,
    maxConcurrentJobs: config.maxConcurrentJobs,
    node: process.version,
    port: CONTAINER_PORT,
    processUptimeMs: Math.round(process.uptime() * 1_000),
  });
  worker.wake();
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  jsonLog("info", "container_stopping", { inFlight: worker.status().inFlight, signal });
  const grace = sleep(SHUTDOWN_GRACE_MS).then(() => "grace_expired" as const);
  const outcome = await Promise.race([worker.stop().then(() => "drained" as const), grace]);
  server.close();
  jsonLog("info", "container_stopped", { outcome });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
