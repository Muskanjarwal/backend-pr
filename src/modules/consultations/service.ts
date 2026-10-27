import { randomUUID } from "node:crypto";
import type { Deps } from "../../deps.js";
import type { Queryable, Row } from "../../db/types.js";
import { conflict, forbidden, notFound } from "../../lib/errors.js";
import { decodeCursor, encodeCursor } from "../../lib/validate.js";
import { enqueue } from "../../jobs/queue.js";
import type { Ctx } from "../auth/rbac.js";

export type ConsultationStatus = "pending_payment" | "confirmed" | "in_progress" | "completed" | "cancelled" | "expired" | "no_show";

/** The only legal moves. Every status write goes through `transition`, which checks this table. */
export const TRANSITIONS: Record<ConsultationStatus, readonly ConsultationStatus[]> = {
  pending_payment: ["confirmed", "cancelled", "expired"],
  confirmed: ["in_progress", "cancelled", "no_show"],
  in_progress: ["completed"],
  completed: [],
  cancelled: [],
  expired: [],
  no_show: [],
};

const MAX_PENDING_HOLDS_PER_PATIENT = 3;
const START_EARLY_MS = 10 * 60_000;
const NO_SHOW_GRACE_MS = 10 * 60_000;

export interface ListFilter {
  status?: ConsultationStatus;
  from?: Date;
  to?: Date;
  doctorId?: string; // admin only
  patientId?: string; // admin only
  limit: number;
  cursor?: string;
}

const reasonAad = (id: string) => `consultations.reason:${id}`;

const SELECT_VIEW = `
  SELECT c.*, p.id AS pay_id, p.status AS pay_status, p.amount_minor, p.currency, p.checkout_url
  FROM consultations c
  LEFT JOIN LATERAL (SELECT * FROM payments WHERE consultation_id = c.id ORDER BY created_at DESC LIMIT 1) p ON true`;

export class ConsultationService {
  constructor(private readonly d: Deps) {}

  // ---- views ---------------------------------------------------------------------------------------------------

  private view(r: Row, viewer: Ctx["actor"]) {
    // Patient-supplied symptoms are PHI: only the two parties to the consultation may read them (admins get metadata only).
    const canSeeReason = viewer.role !== "admin" && r.reason_enc;
    return {
      id: r.id,
      status: r.status as ConsultationStatus,
      slotId: r.slot_id,
      doctorId: r.doctor_id,
      patientId: r.patient_id,
      scheduledStart: r.scheduled_start,
      scheduledEnd: r.scheduled_end,
      holdExpiresAt: r.hold_expires_at,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      cancelReason: r.cancel_reason,
      reason: canSeeReason ? this.d.cipher.decrypt(r.reason_enc, reasonAad(r.id)) : null,
      payment: r.pay_id ? { id: r.pay_id, status: r.pay_status, amountMinor: r.amount_minor, currency: r.currency, checkoutUrl: r.checkout_url } : null,
      createdAt: r.created_at,
    };
  }

  private assertParticipant(r: Row, actor: Ctx["actor"]): void {
    const ok = actor.role === "admin" || (actor.role === "patient" && r.patient_id === actor.id) || (actor.role === "doctor" && r.doctor_id === actor.id);
    // 404 rather than 403: don't confirm the existence of other people's consultations.
    if (!ok) throw notFound("Consultation");
  }

  // ---- booking -------------------------------------------------------------------------------------------------

  /** Saga step 1 (local transaction): hold the slot, create consultation+payment, emit outbox job. Runs inside the caller's idempotent tx. */
  async book(q: Queryable, ctx: Ctx, input: { slotId: string; reason?: string }) {
    const now = this.d.clock.now();
    const holdUntil = new Date(now.getTime() + this.d.config.SLOT_HOLD_MINUTES * 60_000);

    // Abandoned checkout still occupying this slot? Release it first (lock order: consultation → payment → slot).
    const stale = await q.query<{ id: string }>(
      `UPDATE consultations SET status = 'expired', hold_expires_at = NULL, updated_at = $2
       WHERE slot_id = $1 AND status = 'pending_payment' AND hold_expires_at <= $2 RETURNING id`,
      [input.slotId, now],
    );
    if (stale.rowCount) {
      await q.query(`UPDATE payments SET status = 'failed', failure_reason = 'hold_expired', updated_at = $2 WHERE consultation_id = ANY($1::uuid[]) AND status = 'pending'`, [stale.rows.map((r) => r.id), now]);
    }

    // The atomic claim. Exactly one concurrent transaction can flip open→held; everyone else matches zero rows.
    const held = await q.query<{ doctor_id: string; starts_at: Date; ends_at: Date }>(
      `UPDATE availability_slots SET status = 'held', held_until = $2, updated_at = $3
       WHERE id = $1 AND starts_at > $3 AND (status = 'open' OR (status = 'held' AND held_until <= $3))
       RETURNING doctor_id, starts_at, ends_at`,
      [input.slotId, holdUntil, now],
    );
    const slot = held.rows[0];
    if (!slot) {
      const exists = await q.query(`SELECT 1 FROM availability_slots WHERE id = $1`, [input.slotId]);
      this.d.metrics.bookings.inc({ outcome: "slot_unavailable" });
      throw exists.rowCount ? conflict("SLOT_UNAVAILABLE", "This slot is no longer available") : notFound("Slot");
    }

    const doctor = await q.query<{ fee_minor: number; currency: string }>(
      `SELECT d.fee_minor, d.currency FROM doctors d JOIN users u ON u.id = d.user_id
       WHERE d.user_id = $1 AND d.verification_status = 'verified' AND u.status = 'active'`,
      [slot.doctor_id],
    );
    if (!doctor.rows[0]) throw conflict("DOCTOR_UNAVAILABLE", "This doctor is not accepting bookings");

    const mine = await q.query<{ pending: number; overlapping: number }>(
      `SELECT count(*) FILTER (WHERE status = 'pending_payment')::int AS pending,
              count(*) FILTER (WHERE scheduled_start < $3 AND scheduled_end > $2
                                 AND status IN ('pending_payment','confirmed','in_progress'))::int AS overlapping
       FROM consultations WHERE patient_id = $1 AND status IN ('pending_payment','confirmed','in_progress')`,
      [ctx.actor.id, slot.starts_at, slot.ends_at],
    );
    // Cap unpaid holds per patient so one account can't sweep a doctor's calendar and starve everyone else.
    if ((mine.rows[0]?.pending ?? 0) >= MAX_PENDING_HOLDS_PER_PATIENT) throw conflict("TOO_MANY_PENDING_BOOKINGS", "Complete or cancel your pending bookings first");
    if ((mine.rows[0]?.overlapping ?? 0) > 0) throw conflict("PATIENT_OVERLAP", "You already have a consultation at this time");

    const id = randomUUID();
    const paymentId = randomUUID();
    await q.query(
      `INSERT INTO consultations (id, slot_id, patient_id, doctor_id, status, scheduled_start, scheduled_end, reason_enc, hold_expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'pending_payment',$5,$6,$7,$8,$9,$9)`,
      [id, input.slotId, ctx.actor.id, slot.doctor_id, slot.starts_at, slot.ends_at, input.reason ? this.d.cipher.encrypt(input.reason, reasonAad(id)) : null, holdUntil, now],
    );
    await q.query(
      `INSERT INTO payments (id, consultation_id, patient_id, amount_minor, currency, status, provider, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$7)`,
      [paymentId, id, ctx.actor.id, doctor.rows[0].fee_minor, doctor.rows[0].currency, this.d.paymentProvider.name, now],
    );
    // Outbox: committed atomically with the booking, so we can never hold a slot without a payment intent being requested.
    await enqueue(q, now, "payment.create_intent", { paymentId }, { dedupeKey: `intent:${paymentId}` });
    await this.d.audit.record(q, { actorId: ctx.actor.id, actorRole: ctx.actor.role, action: "consultation.book", entityType: "consultation", entityId: id, ip: ctx.ip, requestId: ctx.requestId, metadata: { slotId: input.slotId, doctorId: slot.doctor_id } });

    this.d.metrics.bookings.inc({ outcome: "held" });
    this.d.metrics.consultationTransitions.inc({ to: "pending_payment" });
    const row = (await q.query(`${SELECT_VIEW} WHERE c.id = $1`, [id])).rows[0] as Row;
    return { view: this.view(row, ctx.actor), doctorId: slot.doctor_id as string };
  }

  // ---- reads ---------------------------------------------------------------------------------------------------

  async get(ctx: Ctx, id: string) {
    const { rows } = await this.d.db.query(`${SELECT_VIEW} WHERE c.id = $1`, [id]);
    const row = rows[0];
    if (!row) throw notFound("Consultation");
    this.assertParticipant(row, ctx.actor);
    if (ctx.actor.role === "admin") await this.d.audit.record(this.d.db, { actorId: ctx.actor.id, actorRole: "admin", action: "consultation.read", entityType: "consultation", entityId: id, ip: ctx.ip, requestId: ctx.requestId });
    return this.view(row, ctx.actor);
  }

  async list(ctx: Ctx, f: ListFilter) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => (params.push(v), where.push(sql.replaceAll("?", `$${params.length}`)));
    if (ctx.actor.role === "patient") add("c.patient_id = ?", ctx.actor.id);
    else if (ctx.actor.role === "doctor") add("c.doctor_id = ?", ctx.actor.id);
    else {
      if (f.patientId) add("c.patient_id = ?", f.patientId);
      if (f.doctorId) add("c.doctor_id = ?", f.doctorId);
    }
    if (f.status) add("c.status = ?", f.status);
    if (f.from) add("c.scheduled_start >= ?", f.from);
    if (f.to) add("c.scheduled_start < ?", f.to);
    const cursor = decodeCursor<[string, string]>(f.cursor);
    if (cursor) {
      params.push(cursor[0], cursor[1]);
      where.push(`(c.scheduled_start, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(f.limit + 1);
    const { rows } = await this.d.db.query(
      `${SELECT_VIEW} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY c.scheduled_start DESC, c.id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, f.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.view(r, ctx.actor)),
      nextCursor: rows.length > f.limit && last ? encodeCursor([new Date(last.scheduled_start).toISOString(), last.id]) : null,
    };
  }

  // ---- lifecycle -----------------------------------------------------------------------------------------------

  private async lock(q: Queryable, id: string, ctx: Ctx): Promise<Row> {
    const { rows } = await q.query(`SELECT * FROM consultations WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) throw notFound("Consultation");
    this.assertParticipant(rows[0], ctx.actor);
    return rows[0];
  }

  private async transition(q: Queryable, c: Row, to: ConsultationStatus, extra: Record<string, unknown> = {}): Promise<void> {
    if (!TRANSITIONS[c.status as ConsultationStatus].includes(to)) {
      throw conflict("INVALID_STATE", `Cannot move a ${c.status} consultation to ${to}`);
    }
    const cols = ["status", "updated_at", ...Object.keys(extra)];
    const params = [c.id, to, this.d.clock.now(), ...Object.values(extra)];
    await q.query(`UPDATE consultations SET ${cols.map((col, i) => `${col} = $${i + 2}`).join(", ")} WHERE id = $1`, params);
    this.d.metrics.consultationTransitions.inc({ to });
  }

  async cancel(ctx: Ctx, id: string, reason: string | undefined) {
    const doctorId = await this.d.db.tx(async (q) => {
      const c = await this.lock(q, id, ctx);
      if (c.status === "cancelled") return null; // idempotent retry
      const now = this.d.clock.now();

      const wasPaid = c.status === "confirmed";
      await this.transition(q, c, "cancelled", { cancelled_by: ctx.actor.id, cancel_reason: reason ?? null, hold_expires_at: null });

      if (c.status === "pending_payment") {
        await q.query(`UPDATE payments SET status = 'failed', failure_reason = 'cancelled', updated_at = $2 WHERE consultation_id = $1 AND status = 'pending'`, [id, now]);
      }
      // Reopen the slot unless it is already in the past.
      await q.query(`UPDATE availability_slots SET status = CASE WHEN starts_at > $2 THEN 'open' ELSE 'cancelled' END, held_until = NULL, updated_at = $2 WHERE id = $1 AND status IN ('held','booked')`, [c.slot_id, now]);

      let refund = false;
      if (wasPaid) {
        const leadMs = new Date(c.scheduled_start).getTime() - now.getTime();
        // Provider/admin cancellations always refund; patients get a refund inside the free-cancellation window.
        refund = ctx.actor.role !== "patient" || leadMs >= this.d.config.FREE_CANCELLATION_HOURS * 3_600_000;
        if (refund) {
          const p = await q.query<{ id: string }>(`UPDATE payments SET status = 'refund_pending', updated_at = $2 WHERE consultation_id = $1 AND status = 'succeeded' RETURNING id`, [id, now]);
          for (const row of p.rows) await enqueue(q, now, "payment.refund", { paymentId: row.id }, { dedupeKey: `refund:${row.id}` });
        }
      }
      const other = ctx.actor.id === c.patient_id ? c.doctor_id : c.patient_id;
      if (ctx.actor.role !== "admin") await enqueue(q, now, "notify", { userId: other, template: "consultation.cancelled", data: { consultationId: id, refund } });
      await this.d.audit.record(q, { actorId: ctx.actor.id, actorRole: ctx.actor.role, action: "consultation.cancel", entityType: "consultation", entityId: id, ip: ctx.ip, requestId: ctx.requestId, metadata: { from: c.status, refund } });
      return c.doctor_id as string;
    });
    if (doctorId) await this.d.readThrough.bump(`slots:${doctorId}`);
    return this.get(ctx, id);
  }

  async start(ctx: Ctx, id: string) {
    await this.d.db.tx(async (q) => {
      const c = await this.lock(q, id, ctx);
      this.assertDoctor(c, ctx);
      const now = this.d.clock.now();
      if (now.getTime() < new Date(c.scheduled_start).getTime() - START_EARLY_MS) throw conflict("TOO_EARLY", "Consultation cannot be started yet");
      if (now >= new Date(c.scheduled_end)) throw conflict("TOO_LATE", "The scheduled time has passed");
      await this.transition(q, c, "in_progress", { started_at: now });
      await this.d.audit.record(q, { actorId: ctx.actor.id, actorRole: ctx.actor.role, action: "consultation.start", entityType: "consultation", entityId: id, ip: ctx.ip, requestId: ctx.requestId });
    });
    return this.get(ctx, id);
  }

  async complete(ctx: Ctx, id: string) {
    await this.d.db.tx(async (q) => {
      const c = await this.lock(q, id, ctx);
      this.assertDoctor(c, ctx);
      await this.transition(q, c, "completed", { ended_at: this.d.clock.now() });
      await enqueue(q, this.d.clock.now(), "notify", { userId: c.patient_id, template: "consultation.completed", data: { consultationId: id } });
      await this.d.audit.record(q, { actorId: ctx.actor.id, actorRole: ctx.actor.role, action: "consultation.complete", entityType: "consultation", entityId: id, ip: ctx.ip, requestId: ctx.requestId });
    });
    return this.get(ctx, id);
  }

  async markNoShow(ctx: Ctx, id: string) {
    await this.d.db.tx(async (q) => {
      const c = await this.lock(q, id, ctx);
      this.assertDoctor(c, ctx);
      if (this.d.clock.now().getTime() < new Date(c.scheduled_start).getTime() + NO_SHOW_GRACE_MS) throw conflict("TOO_EARLY", "Wait until the grace period has passed");
      await this.transition(q, c, "no_show", { ended_at: this.d.clock.now() });
      await this.d.audit.record(q, { actorId: ctx.actor.id, actorRole: ctx.actor.role, action: "consultation.no_show", entityType: "consultation", entityId: id, ip: ctx.ip, requestId: ctx.requestId });
    });
    return this.get(ctx, id);
  }

  private assertDoctor(c: Row, ctx: Ctx): void {
    if (ctx.actor.role !== "doctor" || c.doctor_id !== ctx.actor.id) throw forbidden("Only the assigned doctor can do this");
  }

  // ---- saga compensation: abandoned checkouts ------------------------------------------------------------------

  /**
   * Compensating action for a booking whose payment never arrived. Runs from the `expire_holds` cron job. SKIP LOCKED
   * lets several workers sweep in parallel; a payment webhook racing us holds the same row lock, so it either confirms
   * first (we skip it) or loses cleanly and is refunded by the webhook handler.
   */
  async expireHolds(batch = 100): Promise<number> {
    let total = 0;
    for (;;) {
      const now = this.d.clock.now();
      const n = await this.d.db.tx(async (q) => {
        const due = await q.query<{ id: string; slot_id: string; doctor_id: string }>(
          `SELECT id, slot_id, doctor_id FROM consultations
           WHERE status = 'pending_payment' AND hold_expires_at <= $1
           ORDER BY hold_expires_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
          [now, batch],
        );
        if (due.rowCount === 0) return { n: 0, doctors: [] as string[] };
        const ids = due.rows.map((r) => r.id);
        await q.query(`UPDATE consultations SET status = 'expired', hold_expires_at = NULL, updated_at = $2 WHERE id = ANY($1::uuid[])`, [ids, now]);
        await q.query(`UPDATE payments SET status = 'failed', failure_reason = 'hold_expired', updated_at = $2 WHERE consultation_id = ANY($1::uuid[]) AND status = 'pending'`, [ids, now]);
        await q.query(`UPDATE availability_slots SET status = 'open', held_until = NULL, updated_at = $2 WHERE id = ANY($1::uuid[]) AND status = 'held'`, [due.rows.map((r) => r.slot_id), now]);
        for (const r of due.rows) await this.d.audit.record(q, { action: "consultation.expire", actorRole: "system", entityType: "consultation", entityId: r.id });
        return { n: ids.length, doctors: [...new Set(due.rows.map((r) => r.doctor_id))] };
      });
      if (n.n === 0) return total;
      total += n.n;
      for (const doc of n.doctors) await this.d.readThrough.bump(`slots:${doc}`);
      for (let i = 0; i < n.n; i++) this.d.metrics.consultationTransitions.inc({ to: "expired" });
      if (n.n < batch) return total;
    }
  }
}
