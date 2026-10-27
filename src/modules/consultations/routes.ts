import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../../deps.js";
import { isoDate, limit, parse, uuid } from "../../lib/validate.js";
import { ctxOf, makeAuthGuards } from "../../plugins/auth.js";
import type { Services } from "../../container.js";

const idParam = z.object({ id: uuid });

const bookBody = z.object({ slotId: uuid, reason: z.string().trim().min(1).max(2000).optional() }).strict();
const cancelBody = z.object({ reason: z.string().trim().max(500).optional() }).strict().default({});
const prescriptionBody = z
  .object({
    items: z
      .array(
        z
          .object({
            medicine: z.string().trim().min(1).max(200),
            dosage: z.string().trim().min(1).max(100),
            frequency: z.string().trim().min(1).max(100),
            durationDays: z.number().int().min(1).max(365),
            instructions: z.string().trim().max(500).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    notes: z.string().trim().max(5000).optional(),
  })
  .strict();

const listQuery = z.object({
  status: z.enum(["pending_payment", "confirmed", "in_progress", "completed", "cancelled", "expired", "no_show"]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  doctorId: uuid.optional(),
  patientId: uuid.optional(),
  limit,
  cursor: z.string().max(500).optional(),
});

export function consultationRoutes(app: FastifyInstance, d: Deps, s: Services): void {
  const { guard } = makeAuthGuards(s.auth.tokens);

  app.post("/v1/consultations", { preHandler: guard("consultation:book") }, async (req, reply) => {
    const body = parse(bookBody, req.body);
    const ctx = ctxOf(req);
    let doctorId: string | undefined;
    const res = await s.idempotency.run(req, { required: true }, async (q) => {
      const { view, doctorId: doc } = await s.consultations.book(q, ctx, body);
      doctorId = doc;
      return { status: 201, body: view };
    });
    if (doctorId) await s.doctors.invalidate(doctorId); // after commit; skipped on replay
    if (res.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(res.status).send(res.body);
  });

  app.get("/v1/consultations", { preHandler: guard("consultation:read") }, async (req) => s.consultations.list(ctxOf(req), parse(listQuery, req.query)));

  app.get("/v1/consultations/:id", { preHandler: guard("consultation:read") }, async (req) => s.consultations.get(ctxOf(req), parse(idParam, req.params).id));

  app.post("/v1/consultations/:id/cancel", { preHandler: guard("consultation:cancel") }, async (req) => {
    const body = parse(cancelBody, req.body ?? {});
    return s.consultations.cancel(ctxOf(req), parse(idParam, req.params).id, body.reason);
  });

  app.post("/v1/consultations/:id/start", { preHandler: guard("consultation:run") }, async (req) => s.consultations.start(ctxOf(req), parse(idParam, req.params).id));
  app.post("/v1/consultations/:id/complete", { preHandler: guard("consultation:run") }, async (req) => s.consultations.complete(ctxOf(req), parse(idParam, req.params).id));
  app.post("/v1/consultations/:id/no-show", { preHandler: guard("consultation:run") }, async (req) => s.consultations.markNoShow(ctxOf(req), parse(idParam, req.params).id));

  app.post("/v1/consultations/:id/prescriptions", { preHandler: guard("prescription:write") }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(prescriptionBody, req.body);
    const ctx = ctxOf(req);
    const res = await s.idempotency.run(req, { required: true }, async (q) => ({ status: 201, body: await s.prescriptions.create(q, ctx, id, body) }));
    if (res.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(res.status).send(res.body);
  });

  app.get("/v1/consultations/:id/prescriptions", { preHandler: guard("prescription:read") }, async (req) =>
    s.prescriptions.listForConsultation(ctxOf(req), parse(idParam, req.params).id),
  );
}
