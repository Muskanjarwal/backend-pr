import http from "node:http";
import pino from "pino";
import { connect } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { Worker } from "./jobs/worker.js";
import { loggerOptions } from "./observability/logger.js";

const config = loadConfig();
const log = pino({ ...loggerOptions(config), base: { service: "amrutam-worker" } } as pino.LoggerOptions);
const { db, redis, deps } = connect(config, log);
const worker = new Worker(deps, log);
worker.start();
log.info("worker started");

const server = http.createServer(async (req, res) => {
  if (req.url === "/metrics") {
    res.writeHead(200, { "content-type": deps.metrics.registry.contentType });
    res.end(await deps.metrics.registry.metrics());
  } else if (req.url === "/healthz") {
    res.writeHead(200).end("ok");
  } else {
    res.writeHead(404).end();
  }
});
server.listen(config.WORKER_METRICS_PORT, "0.0.0.0");

async function shutdown() {
  log.info("worker draining");
  await worker.stop(); // finish the in-flight batch; unfinished jobs would be re-claimed after their lease anyway
  server.close();
  await db.close();
  redis?.disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
