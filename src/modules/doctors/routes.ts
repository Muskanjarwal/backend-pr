import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../../deps.js";
import { isoDate, limit, parse, uuid } from "../../lib/validate.js";
import { ctxOf, makeAuthGuards } from "../../plugins/auth.js";
import type { Services } from "../../container.js";

const searchSchema = z.object({
  specialty: z.string().min(2).max(60).optional(),
  q: z.string().min(1).max(60).optional(),
  language: z.string().min(2).max(30).optional(),
  maxFeeMinor: z.coerce.number().int().min(0).optional(),
  availableFrom: isoDate.optional(),
  availableTo: isoDate.optional(),
  limit,
  cursor: z.string().max(500).optional(),
});

const slotsBody = z
  .object({
    windows: z.array(z.object({ start: isoDate, end: isoDate }).strict()).min(1).max(31),
    slotMinutes: z.union([z.literal(15), z.literal(20), z.literal(30), z.literal(45), z.literal(60)]),
  })
  .strict();

const profilePatch = z
  .object({
    specialty: z.string().trim().min(2).max(60),
    bio: z.string().max(2000),
    languages: z.array(z.string().trim().min(2).max(30)).max(10),
    feeMinor: z.number().int().min(0).max(10_000_000),
    yearsExperience: z.number().int().min(0).max(70),
  })
  .partial()
  .strict();

export function doctorRoutes(app: FastifyInstance, d: Deps, s: Services): void {
  const { guard } = makeAuthGuards(s.auth.tokens);

  app.get("/v1/doctors", { preHandler: guard("doctor:search") }, async (req) => s.doctors.search(parse(searchSchema, req.query)));

  app.get("/v1/doctors/:id", { preHandler: guard("doctor:search") }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return s.doctors.get(id, ctxOf(req));
  });

  app.patch("/v1/doctors/me", { preHandler: guard("doctor:profile:update") }, async (req) => s.doctors.updateProfile(ctxOf(req), parse(profilePatch, req.body)));

  app.post("/v1/doctors/me/slots", { preHandler: guard("slot:manage") }, async (req, reply) => {
    const body = parse(slotsBody, req.body);
    return reply.status(201).send(await s.doctors.createSlots(ctxOf(req), body.windows, body.slotMinutes));
  });

  app.delete("/v1/doctors/me/slots/:slotId", { preHandler: guard("slot:manage") }, async (req, reply) => {
    const { slotId } = parse(z.object({ slotId: uuid }), req.params);
    await s.doctors.cancelSlot(ctxOf(req), slotId);
    return reply.status(204).send();
  });

  app.get("/v1/doctors/:id/slots", { preHandler: guard("slot:read") }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const q = parse(z.object({ from: isoDate.optional(), to: isoDate.optional() }), req.query);
    return s.doctors.listSlots(id, q.from, q.to);
  });
}
