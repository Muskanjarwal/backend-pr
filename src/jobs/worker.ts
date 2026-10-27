import type { FastifyBaseLogger } from "fastify";
import type { Deps } from "../deps.js";
import { CRON, buildHandlers, type Handler } from "./handlers.js";
import { JobStore } from "./queue.js";

const LEASE_MS = 60_000;

export class Worker {
  private readonly store: JobStore;
  private readonly handlers: Record<string, Handler>;
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly d: Deps,
    private readonly log: Pick<FastifyBaseLogger, "info" | "warn" | "error">,
    handlers?: Record<string, Handler>,
  ) {
    this.store = new JobStore(d.db);
    this.handlers = handlers ?? buildHandlers(d);
  }

  /** Claim and execute one batch. Returns the number of jobs attempted. Exposed so tests can drive the queue deterministically. */
  async runOnce(limit = this.d.config.WORKER_CONCURRENCY): Promise<number> {
    const now = this.d.clock.now();
    for (const c of CRON) await this.store.ensureRecurring(now, c.type, c.everyMs);
    const jobs = await this.store.claim(now, limit, LEASE_MS);
    this.d.metrics.jobQueueDepth.set(await this.store.depth(now));

    await Promise.all(
      jobs.map(async (job) => {
        const end = this.d.metrics.jobDuration.startTimer({ type: job.type });
        try {
          const handler = this.handlers[job.type];
          if (!handler) throw new Error(`no handler registered for job type "${job.type}"`);
          await handler(job.payload);
          await this.store.succeed(job.id, this.d.clock.now());
          this.d.metrics.jobsProcessed.inc({ type: job.type, outcome: "ok" });
        } catch (err) {
          const verdict = await this.store.fail(job, err, this.d.clock.now());
          this.d.metrics.jobsProcessed.inc({ type: job.type, outcome: verdict === "dead" ? "dead" : "retry" });
          this.log[verdict === "dead" ? "error" : "warn"]({ jobId: job.id, type: job.type, attempt: job.attempts, err: String((err as Error).message) }, `job failed (${verdict})`);
        } finally {
          end();
        }
      }),
    );
    return jobs.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        let n = 0;
        try {
          n = await this.runOnce();
        } catch (err) {
          this.log.error({ err }, "worker iteration failed");
        }
        // Busy queue → poll again immediately; idle → sleep. Keeps latency low without hammering the DB.
        if (n === 0) await new Promise((r) => setTimeout(r, this.d.config.WORKER_POLL_MS));
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }
}
