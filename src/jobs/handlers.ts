import type { Deps } from "../deps.js";
import { ensureAuditPartitions } from "../modules/audit/partitions.js";
import { AnalyticsService } from "../modules/admin/analytics.js";
import { ConsultationService } from "../modules/consultations/service.js";
import { PaymentService } from "../modules/payments/service.js";

export type Handler = (payload: any) => Promise<void>;

export interface CronSpec {
  type: string;
  everyMs: number;
}

/** Recurring work, scheduled via ensureRecurring so any number of worker replicas can run without double-firing. */
export const CRON: CronSpec[] = [
  { type: "expire_holds", everyMs: 30_000 },
  { type: "analytics.refresh", everyMs: 5 * 60_000 },
  { type: "maintenance.cleanup", everyMs: 60 * 60_000 },
];

export function buildHandlers(d: Deps): Record<string, Handler> {
  const payments = new PaymentService(d);
  const consultations = new ConsultationService(d);
  const analytics = new AnalyticsService(d);

  return {
    "payment.create_intent": (p) => payments.createIntent(p.paymentId),
    "payment.refund": (p) => payments.refund(p.paymentId),
    notify: (p) => d.notifier.send({ userId: p.userId, template: p.template, data: p.data ?? {} }),
    expire_holds: async () => void (await consultations.expireHolds()),
    "analytics.refresh": async () => void (await analytics.refreshRecent()),
    "maintenance.cleanup": async () => {
      const now = d.clock.now();
      const day = 86_400_000;
      await d.db.query(`DELETE FROM idempotency_keys WHERE expires_at < $1`, [now]);
      await d.db.query(`DELETE FROM jobs WHERE status = 'succeeded' AND updated_at < $1`, [new Date(now.getTime() - 7 * day)]);
      await d.db.query(`DELETE FROM refresh_tokens WHERE expires_at < $1`, [new Date(now.getTime() - 7 * day)]);
      await d.db.query(`DELETE FROM processed_webhook_events WHERE received_at < $1`, [new Date(now.getTime() - 30 * day)]);
      await ensureAuditPartitions(d.db, now, 3);
    },
  };
}
