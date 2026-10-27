import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../../deps.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { decodeCursor, encodeCursor, isoDate, limit, parse, uuid } from "../../lib/validate.js";
import { enqueue } from "../../jobs/queue.js";
import { ctxOf, makeAuthGuards } from "../../plugins/auth.js";
import type { Services } from "../../container.js";

const range = z.object({ from: isoDate, to: isoDate });

export function adminRoutes(app: FastifyInstance, d: Deps, s: Services): void {
  const { guard } = makeAuthGuards(s.auth.tokens);

  app.get("/v1/admin/doctors", { preHandler: guard("admin:doctors") }, async (req) => {
    const q = parse(z.object({ status: z.enum(["pending", "verified", "rejected"]).default("pending"), limit }), req.query);
    return s.doctors.listForAdmin(q.status, q.limit);
  });

  app.post("/v1/admin/doctors/:id/verification", { preHandler: guard("admin:doctors") }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ status: z.enum(["verified", "rejected"]) }).strict(), req.body);
    await s.doctors.setVerification(ctxOf(req), id, body.status);
    return reply.status(204).send();
  });

  for (const [action, status] of [["suspend", "suspended"], ["reinstate", "active"]] as const) {
    app.post(`/v1/admin/users/:id/${action}`, { preHandler: guard("admin:users") }, async (req, reply) => {
      const ctx = ctxOf(req);
      const { id } = parse(z.object({ id: uuid }), req.params);
      if (id === ctx.actor.id) throw badRequest("You cannot change your own account status");
      await d.db.tx(async (q) => {
        const now = d.clock.now();
        const r = await q.query(`UPDATE users SET status = $2, updated_at = $3 WHERE id = $1`, [id, status, now]);
        if (r.rowCount === 0) throw notFound("User");
        // Suspension takes effect for refresh immediately; already-issued access tokens lapse within ACCESS_TOKEN_TTL_SEC.
        if (status === "suspended") await q.query(`UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [id, now]);
        await d.audit.record(q, { actorId: ctx.actor.id, actorRole: "admin", action: `user.${action}`, entityType: "user", entityId: id, ip: ctx.ip, requestId: ctx.requestId });
      });
      await s.doctors.invalidate(id);
      await d.readThrough.bump("doctors");
      return reply.status(204).send();
    });
  }

  app.get("/v1/admin/audit-logs", { preHandler: guard("admin:audit") }, async (req) => {
    const q = parse(
      z.object({
        actorId: uuid.optional(),
        entityType: z.string().max(60).optional(),
        entityId: z.string().max(80).optional(),
        action: z.string().max(80).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        verify: z.enum(["true", "false"]).default("false"),
        limit,
        cursor: z.string().max(500).optional(),
      }),
      req.query,
    );
    const cursor = decodeCursor<{ occurredAt: string; id: string }>(q.cursor);
    const ctx = ctxOf(req);
    await d.audit.record(d.db, { actorId: ctx.actor.id, actorRole: "admin", action: "audit.read", entityType: "audit_logs", ip: ctx.ip, requestId: ctx.requestId, metadata: { filters: Object.keys(req.query as object) } });
    const res = await d.audit.search(d.db, { ...q, cursor }, q.verify === "true");
    return { items: res.items, nextCursor: res.nextCursor ? encodeCursor(res.nextCursor) : null };
  });

  app.get("/v1/admin/analytics/summary", { preHandler: guard("admin:analytics") }, async (req) => {
    const q = parse(range, req.query);
    return s.analytics.summary(q.from, q.to);
  });

  app.get("/v1/admin/analytics/doctor-utilization", { preHandler: guard("admin:analytics") }, async (req) => {
    const q = parse(range.extend({ limit }), req.query);
    return s.analytics.doctorUtilization(q.from, q.to, q.limit);
  });

  // Heavy recompute runs on the worker, never on the request path.
  app.post("/v1/admin/analytics/refresh", { preHandler: guard("admin:analytics") }, async (req, reply) => {
    await enqueue(d.db, d.clock.now(), "analytics.refresh", {}, { dedupeKey: "analytics.refresh:manual" });
    return reply.status(202).send({ status: "queued" });
  });
}
