import { randomUUID } from "node:crypto";
import type { Deps } from "../../deps.js";
import type { Queryable, Row } from "../../db/types.js";
import { conflict, forbidden, notFound } from "../../lib/errors.js";
import { enqueue } from "../../jobs/queue.js";
import type { Ctx } from "../auth/rbac.js";

export interface PrescriptionItem {
  medicine: string;
  dosage: string;
  frequency: string;
  durationDays: number;
  instructions?: string;
}

const notesAad = (id: string) => `prescriptions.notes:${id}`;

export class PrescriptionService {
  constructor(private readonly d: Deps) {}

  private view(r: Row) {
    return {
      id: r.id,
      consultationId: r.consultation_id,
      doctorId: r.doctor_id,
      patientId: r.patient_id,
      items: r.items as PrescriptionItem[],
      notes: r.notes_enc ? this.d.cipher.decrypt(r.notes_enc, notesAad(r.id)) : null,
      createdAt: r.created_at,
    };
  }

  /** Runs inside the caller's idempotent transaction. */
  async create(q: Queryable, ctx: Ctx, consultationId: string, input: { items: PrescriptionItem[]; notes?: string }) {
    const { rows } = await q.query(`SELECT id, doctor_id, patient_id, status FROM consultations WHERE id = $1 FOR SHARE`, [consultationId]);
    const c = rows[0];
    if (!c || c.doctor_id !== ctx.actor.id) throw notFound("Consultation"); // doctors only see their own
    if (c.status !== "in_progress" && c.status !== "completed") throw conflict("INVALID_STATE", "Prescriptions can only be issued for a consultation that has started");

    const id = randomUUID();
    const now = this.d.clock.now();
    await q.query(`INSERT INTO prescriptions (id, consultation_id, doctor_id, patient_id, items, notes_enc, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      id, consultationId, ctx.actor.id, c.patient_id, JSON.stringify(input.items), input.notes ? this.d.cipher.encrypt(input.notes, notesAad(id)) : null, now,
    ]);
    await enqueue(q, now, "notify", { userId: c.patient_id, template: "prescription.issued", data: { consultationId, prescriptionId: id } });
    await this.d.audit.record(q, { actorId: ctx.actor.id, actorRole: ctx.actor.role, action: "prescription.create", entityType: "prescription", entityId: id, ip: ctx.ip, requestId: ctx.requestId, metadata: { consultationId, items: input.items.length } });
    const created = (await q.query(`SELECT * FROM prescriptions WHERE id = $1`, [id])).rows[0] as Row;
    return this.view(created);
  }

  async listForConsultation(ctx: Ctx, consultationId: string) {
    const c = (await this.d.db.query(`SELECT patient_id, doctor_id FROM consultations WHERE id = $1`, [consultationId])).rows[0];
    if (!c) throw notFound("Consultation");
    const allowed = ctx.actor.role === "admin" || c.patient_id === ctx.actor.id || c.doctor_id === ctx.actor.id;
    if (!allowed) throw notFound("Consultation");
    if (ctx.actor.role === "admin") throw forbidden("Administrators cannot read clinical content");

    const { rows } = await this.d.db.query(`SELECT * FROM prescriptions WHERE consultation_id = $1 ORDER BY created_at`, [consultationId]);
    // Reading PHI is itself an auditable event (who looked at which record, when).
    await this.d.audit.record(this.d.db, { actorId: ctx.actor.id, actorRole: ctx.actor.role, action: "prescription.read", entityType: "consultation", entityId: consultationId, ip: ctx.ip, requestId: ctx.requestId, metadata: { count: rows.length } });
    return { items: rows.map((r) => this.view(r)) };
  }
}
