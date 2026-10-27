import http from "node:http";
import { buildApp } from "./app.js";
import { connect } from "./bootstrap.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { db, redis, deps } = connect(config, console);

const app = await buildApp(deps, { redis, readinessChecks: redis ? [async () => void (await redis.ping())] : [] });

// Metrics are served on a separate, cluster-internal port so they are never exposed through the public ingress.
const metricsServer = http.createServer(async (req, res) => {
  if (req.url === "/metrics") {
    res.writeHead(200, { "content-type": deps.metrics.registry.contentType });
    res.end(await deps.metrics.registry.metrics());
  } else {
    res.writeHead(404).end();
  }
});
metricsServer.listen(config.METRICS_PORT, "0.0.0.0");

await app.listen({ port: config.PORT, host: "0.0.0.0" });

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  // Stop accepting, let in-flight requests drain (k8s preStop + terminationGracePeriod cover the LB propagation delay).
  await app.close();
  metricsServer.close();
  await db.close();
  redis?.disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
