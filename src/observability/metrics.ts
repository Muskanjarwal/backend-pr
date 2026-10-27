import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { Db } from "../db/types.js";

export interface Metrics {
  registry: Registry;
  httpDuration: Histogram<"method" | "route" | "status">;
  bookings: Counter<"outcome">;
  consultationTransitions: Counter<"to">;
  paymentEvents: Counter<"type" | "outcome">;
  jobsProcessed: Counter<"type" | "outcome">;
  jobDuration: Histogram<"type">;
  jobQueueDepth: Gauge;
  cacheLookups: Counter<"cache" | "result">;
  authEvents: Counter<"event">;
}

export function createMetrics(db?: Db): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  if (db?.poolStats) {
    const stats = db.poolStats.bind(db);
    new Gauge({ name: "db_pool_connections", help: "pg pool connections by state", labelNames: ["state"], registers: [registry],
      collect() {
        const s = stats();
        this.set({ state: "total" }, s.total);
        this.set({ state: "idle" }, s.idle);
        this.set({ state: "waiting" }, s.waiting);
      } });
  }

  return {
    registry,
    httpDuration: new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request latency by route template",
      labelNames: ["method", "route", "status"],
      // Dense around the 200ms read / 500ms write SLO thresholds so p95 is accurate where it matters.
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 2.5, 5],
      registers: [registry],
    }),
    bookings: new Counter({ name: "bookings_total", help: "Booking attempts by outcome", labelNames: ["outcome"], registers: [registry] }),
    consultationTransitions: new Counter({ name: "consultation_transitions_total", help: "Consultation state changes", labelNames: ["to"], registers: [registry] }),
    paymentEvents: new Counter({ name: "payment_events_total", help: "Payment webhook handling", labelNames: ["type", "outcome"], registers: [registry] }),
    jobsProcessed: new Counter({ name: "jobs_processed_total", help: "Background jobs by outcome", labelNames: ["type", "outcome"], registers: [registry] }),
    jobDuration: new Histogram({ name: "job_duration_seconds", help: "Background job runtime", labelNames: ["type"], buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30], registers: [registry] }),
    jobQueueDepth: new Gauge({ name: "job_queue_depth", help: "Jobs ready to run", registers: [registry] }),
    cacheLookups: new Counter({ name: "cache_lookups_total", help: "Cache lookups", labelNames: ["cache", "result"], registers: [registry] }),
    authEvents: new Counter({ name: "auth_events_total", help: "Authentication events", labelNames: ["event"], registers: [registry] }),
  };
}
