import { trace } from "@opentelemetry/api";
import type { FastifyError, FastifyInstance } from "fastify";
import { AppError } from "../lib/errors.js";
import type { Metrics } from "../observability/metrics.js";

/** Consistent error envelope; internals (stack, SQL, constraint names) never reach the client. */
export function registerHttp(app: FastifyInstance, metrics: Metrics): void {
  // Keep the raw body: webhook signatures and idempotency request hashes are computed over exact bytes.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new AppError(400, "INVALID_JSON", "Request body is not valid JSON"), undefined);
    }
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    // Name the server span after the route template ("POST /v1/consultations/:id/cancel"), not the raw URL.
    const span = trace.getActiveSpan();
    if (span && req.routeOptions.url) {
      span.updateName(`${req.method} ${req.routeOptions.url}`);
      span.setAttribute("http.route", req.routeOptions.url);
      span.setAttribute("request.id", req.id);
    }
    (req as any).startAt = process.hrtime.bigint();
  });

  app.addHook("onResponse", async (req, reply) => {
    const start = (req as any).startAt as bigint | undefined;
    if (!start) return;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    // Route *template* (not the URL) as the label: unbounded ids would explode metric cardinality.
    metrics.httpDuration.observe({ method: req.method, route: req.routeOptions.url ?? "unmatched", status: String(reply.statusCode) }, seconds);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: "NOT_FOUND", message: "Route not found", requestId: req.id } });
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ err }, "application error");
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details, requestId: req.id } });
    }
    const status = (err as FastifyError).statusCode;
    if (status === 429) return reply.status(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests", requestId: req.id } });
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: (err as FastifyError).code ?? "BAD_REQUEST", message: err.message, requestId: req.id } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "INTERNAL", message: "Internal server error", requestId: req.id } });
  });
}
