import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";
import type { Deps } from "./deps.js";
import { buildServices } from "./container.js";
import { loggerOptions } from "./observability/logger.js";
import { registerHttp } from "./plugins/http.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { authRoutes } from "./modules/auth/routes.js";
import { consultationRoutes } from "./modules/consultations/routes.js";
import { doctorRoutes } from "./modules/doctors/routes.js";
import { paymentRoutes } from "./modules/payments/routes.js";
import { randomUUID } from "node:crypto";

export interface AppOptions {
  /** Shared limiter store so limits hold across replicas. Without it, limits are per-process. */
  redis?: Redis;
  /** Extra readiness probes (e.g. redis ping). */
  readinessChecks?: Array<() => Promise<void>>;
  /** Called for every registered route; used by the OpenAPI drift test. */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
}

export async function buildApp(d: Deps, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(d.config),
    trustProxy: d.config.TRUST_PROXY,
    bodyLimit: 256 * 1024,
    requestTimeout: 15_000,
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
  });

  if (opts.onRoute) app.addHook("onRoute", opts.onRoute);
  registerHttp(app, d.metrics);
  await app.register(helmet, { contentSecurityPolicy: false, hsts: d.config.NODE_ENV === "production" }); // JSON API: no HTML to protect with CSP
  await app.register(rateLimit, {
    global: true,
    max: d.config.RATE_LIMIT_GLOBAL_PER_MIN,
    timeWindow: "1 minute",
    redis: opts.redis,
    nameSpace: "amrutam:rl:",
    skipOnError: true, // limiter-store outage must not take the API down
    allowList: (req) => req.url === "/healthz" || req.url === "/readyz",
  });

  const services = buildServices(d);

  app.get("/healthz", async () => ({ status: "ok" })); // liveness: process is up, no dependencies touched
  app.get("/readyz", async (_req, reply) => {
    // readiness: can we actually serve? Failing this pulls the pod out of the load balancer without restarting it.
    try {
      await Promise.all([d.db.ping(), ...(opts.readinessChecks ?? []).map((c) => c())]);
      return { status: "ready" };
    } catch {
      return reply.status(503).send({ status: "unavailable" });
    }
  });

  authRoutes(app, d, services);
  doctorRoutes(app, d, services);
  consultationRoutes(app, d, services);
  paymentRoutes(app, d, services);
  adminRoutes(app, d, services);

  return app;
}
