import { z } from "zod";
import type { Deps } from "../../deps.js";
import { AppError, badRequest, notFound, unauthorized } from "../../lib/errors.js";
import { safeEqual, hmacHex } from "../../lib/crypto.js";
import { enqueue } from "../../jobs/queue.js";
import type { Ctx } from "../auth/rbac.js";
import { WEBHOOK_TOLERANCE_SEC, parseSignatureHeader } from "./provider.js";

export const webhookSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().max(100),
  data: z.object({ paymentId: z.string().min(1).max(200) }),
});

const PROVIDER_TIMEOUT_MS = 8_000;
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`provider call timed out after ${ms}ms`)), ms).unref())]);

export class PaymentService {
  constructor(private readonly d: Deps) {}

  /** Authenticates the PSP: HMAC over "<timestamp>.<raw body>", constant-time compare, bounded clock skew. */
  verifySignature(rawBody: string | undefined, header: string | undefined): void {
    const parsed = header ? parseSignatureHeader(header) : null;
    if (!parsed || rawBody === undefined) throw unauthorized("Missing webhook signature", "INVALID_SIGNATURE");
    const skew = Math.abs(this.d.clock.now().getTime() / 1000 - parsed.t);
    if (skew > WEBHOOK_TOLERANCE_SEC) throw unauthorized("Webhook timestamp outside tolerance", "INVALID_SIGNATURE");
    if (!safeEqual(hmacHex(this.d.config.PAYMENT_WEBHOOK_SECRET, `${parsed.t}.${rawBody}`), parsed.v1)) throw unauthorized("Invalid webhook signature", "INVALID_SIGNATURE");
  }

  async get(ctx: Ctx, id: string) {
    const { rows } = await this.d.db.query(`SELECT * FROM payments WHERE id = $1`, [id]);
    const p = rows[0];
    if (!p || (ctx.actor.role === "patient" && p.patient_id !== ctx.actor.id)) throw notFound("Payment");
    if (ctx.actor.role === "doctor") throw notFound("Payment");
    return { id: p.id, consultationId: p.consultation_id, status: p.status, amountMinor: p.amount_minor, currency: p.currency, checkoutUrl: p.checkout_url, failureReason: p.failure_reason };
  }

  /**
   * Saga step 2 (driven by the PSP). Idempotent on event id, and safe against every ordering we can think of:
   * duplicates, replays, a success arriving after the hold expired or the booking was cancelled (→ automatic refund).
   * Lock order is consultation → payment → slot everywhere, so webhooks, cancels and the hold sweeper can't deadlock.
   */
  async handleWebhook(raw: unknown): Promise<{ duplicate: boolean; outcome: string }> {
    const evt = webhookSchema.safeParse(raw);
    if (!evt.success) throw badRequest("Malformed webhook payload");
    const { id: eventId, type, data } = evt.data;
    const provider = this.d.paymentProvider.name;

    const result = await this.d.db.tx(async (q) => {
      const seen = await q.query(`INSERT INTO processed_webhook_events (provider, event_id, received_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [provider, eventId, this.d.clock.now()]);
      if (seen.rowCount === 0) return { duplicate: true, outcome: "duplicate", doctorId: null as string | null };

      const lookup = await q.query<{ consultation_id: string }>(`SELECT consultation_id FROM payments WHERE provider = $1 AND provider_payment_id = $2`, [provider, data.paymentId]);
      // Unknown payment: fail (and roll back the dedupe row) so the PSP retries — our intent job may not have stored its id yet.
      if (!lookup.rows[0]) throw new AppError(404, "PAYMENT_NOT_FOUND", "Unknown payment");

      const c = (await q.query(`SELECT * FROM consultations WHERE id = $1 FOR UPDATE`, [lookup.rows[0].consultation_id])).rows[0]!;
      const pay = (await q.query(`SELECT * FROM payments WHERE provider = $1 AND provider_payment_id = $2 FOR UPDATE`, [provider, data.paymentId])).rows[0]!;
      const now = this.d.clock.now();
      let outcome = "ignored";

      if (type === "payment.succeeded") {
        if (pay.status === "pending" && c.status === "pending_payment") {
          await q.query(`UPDATE payments SET status = 'succeeded', updated_at = $2 WHERE id = $1`, [pay.id, now]);
          await q.query(`UPDATE consultations SET status = 'confirmed', hold_expires_at = NULL, updated_at = $2 WHERE id = $1`, [c.id, now]);
          await q.query(`UPDATE availability_slots SET status = 'booked', held_until = NULL, updated_at = $2 WHERE id = $1`, [c.slot_id, now]);
          for (const userId of [c.patient_id, c.doctor_id]) await enqueue(q, now, "notify", { userId, template: "consultation.confirmed", data: { consultationId: c.id } });
          this.d.metrics.consultationTransitions.inc({ to: "confirmed" });
          outcome = "confirmed";
        } else if (pay.status === "pending" || pay.status === "failed") {
          // Money was captured but the booking no longer exists (expired/cancelled). Compensate: refund.
          await q.query(`UPDATE payments SET status = 'refund_pending', failure_reason = 'late_success', updated_at = $2 WHERE id = $1`, [pay.id, now]);
          await enqueue(q, now, "payment.refund", { paymentId: pay.id }, { dedupeKey: `refund:${pay.id}` });
          outcome = "refund_scheduled";
        }
      } else if (type === "payment.failed") {
        if (pay.status === "pending") {
          await q.query(`UPDATE payments SET status = 'failed', failure_reason = 'provider_declined', updated_at = $2 WHERE id = $1`, [pay.id, now]);
          if (c.status === "pending_payment") {
            await q.query(`UPDATE consultations SET status = 'cancelled', cancel_reason = 'payment_failed', hold_expires_at = NULL, updated_at = $2 WHERE id = $1`, [c.id, now]);
            await q.query(`UPDATE availability_slots SET status = 'open', held_until = NULL, updated_at = $2 WHERE id = $1 AND status = 'held'`, [c.slot_id, now]);
            await enqueue(q, now, "notify", { userId: c.patient_id, template: "payment.failed", data: { consultationId: c.id } });
            this.d.metrics.consultationTransitions.inc({ to: "cancelled" });
          }
          outcome = "payment_failed";
        }
      } else if (type === "refund.succeeded") {
        if (pay.status === "refund_pending") await q.query(`UPDATE payments SET status = 'refunded', updated_at = $2 WHERE id = $1`, [pay.id, now]);
        outcome = "refunded";
      }

      await this.d.audit.record(q, { actorRole: "system", action: `payment.webhook.${type}`, entityType: "payment", entityId: pay.id, metadata: { eventId, outcome } });
      return { duplicate: false, outcome, doctorId: c.doctor_id as string };
    });

    this.d.metrics.paymentEvents.inc({ type, outcome: result.outcome });
    if (result.doctorId) await this.d.readThrough.bump(`slots:${result.doctorId}`);
    return { duplicate: result.duplicate, outcome: result.outcome };
  }

  // ---- job handlers (all idempotent: they re-check state and use provider-side idempotency keys) -----------------

  async createIntent(paymentId: string): Promise<void> {
    const p = (await this.d.db.query(`SELECT * FROM payments WHERE id = $1`, [paymentId])).rows[0];
    if (!p || p.status !== "pending" || p.provider_payment_id) return; // already done, cancelled, or expired
    const intent = await withTimeout(this.d.paymentProvider.createIntent({ paymentId, amountMinor: p.amount_minor, currency: p.currency }), PROVIDER_TIMEOUT_MS);
    await this.d.db.query(
      `UPDATE payments SET provider_payment_id = $2, checkout_url = $3, updated_at = $4 WHERE id = $1 AND provider_payment_id IS NULL`,
      [paymentId, intent.providerPaymentId, intent.checkoutUrl, this.d.clock.now()],
    );
  }

  async refund(paymentId: string): Promise<void> {
    const p = (await this.d.db.query(`SELECT * FROM payments WHERE id = $1`, [paymentId])).rows[0];
    if (!p || p.status !== "refund_pending") return;
    if (!p.provider_payment_id) throw new Error("payment has no provider id yet; retrying"); // intent job hasn't landed — backoff and retry
    const r = await withTimeout(this.d.paymentProvider.refund({ providerPaymentId: p.provider_payment_id, amountMinor: p.amount_minor, idempotencyKey: paymentId }), PROVIDER_TIMEOUT_MS);
    await this.d.db.tx(async (q) => {
      await q.query(`UPDATE payments SET status = 'refunded', provider_refund_id = $2, updated_at = $3 WHERE id = $1 AND status = 'refund_pending'`, [paymentId, r.providerRefundId, this.d.clock.now()]);
      await this.d.audit.record(q, { actorRole: "system", action: "payment.refunded", entityType: "payment", entityId: paymentId });
      await enqueue(q, this.d.clock.now(), "notify", { userId: p.patient_id, template: "payment.refunded", data: { paymentId } });
    });
  }
}
