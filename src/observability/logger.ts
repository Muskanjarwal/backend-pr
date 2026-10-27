import { trace } from "@opentelemetry/api";
import type { FastifyServerOptions } from "fastify";
import type { Config } from "../config.js";

/** Pino options shared by the API and worker. JSON in prod; each line carries trace_id/span_id for log↔trace correlation. */
export function loggerOptions(cfg: Pick<Config, "LOG_LEVEL" | "NODE_ENV">): Exclude<FastifyServerOptions["logger"], boolean | undefined> {
  return {
    level: cfg.NODE_ENV === "test" ? "silent" : cfg.LOG_LEVEL,
    base: { service: "amrutam-api" },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-signature']", "*.password", "*.token", "*.refreshToken"],
      censor: "[redacted]",
    },
    mixin() {
      const ctx = trace.getActiveSpan()?.spanContext();
      return ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
    },
    ...(cfg.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
  };
}
