import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../../deps.js";
import { notFound } from "../../lib/errors.js";
import { parse } from "../../lib/validate.js";
import { ctxOf, makeAuthGuards } from "../../plugins/auth.js";
import type { Services } from "../../container.js";

const password = z.string().min(12, "Password must be at least 12 characters").max(128);
const email = z.email().max(254).transform((s) => s.trim().toLowerCase());

const registerSchema = z
  .object({
    email,
    password,
    fullName: z.string().trim().min(2).max(120),
    phone: z.string().regex(/^\+?[0-9]{8,15}$/).optional(),
    role: z.enum(["patient", "doctor"]),
    doctor: z
      .object({
        specialty: z.string().trim().min(2).max(60),
        registrationNumber: z.string().trim().min(3).max(40),
        yearsExperience: z.number().int().min(0).max(70),
        languages: z.array(z.string().trim().min(2).max(30)).max(10).default([]),
        bio: z.string().max(2000).optional(),
        feeMinor: z.number().int().min(0).max(10_000_000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => (v.role === "doctor") === (v.doctor !== undefined), { message: "doctor details are required for (and only for) role=doctor", path: ["doctor"] })
  .refine((v) => !v.password.toLowerCase().includes(v.email.split("@")[0] ?? "\0"), { message: "Password must not contain your email name", path: ["password"] });

export function authRoutes(app: FastifyInstance, d: Deps, s: Services): void {
  const { guard } = makeAuthGuards(s.auth.tokens);
  const authLimit = { rateLimit: { max: d.config.RATE_LIMIT_AUTH_PER_MIN, timeWindow: "1 minute" } };
  const meta = (req: { ip: string; id: string }) => ({ ip: req.ip, requestId: req.id });

  app.post("/v1/auth/register", { config: authLimit }, async (req, reply) => {
    const user = await s.auth.register(parse(registerSchema, req.body), meta(req));
    return reply.status(201).send(user);
  });

  app.post("/v1/auth/login", { config: authLimit }, async (req) => {
    const body = parse(z.object({ email, password: z.string().min(1).max(128) }).strict(), req.body);
    return s.auth.login(body.email, body.password, meta(req));
  });

  app.post("/v1/auth/mfa/verify", { config: authLimit }, async (req) => {
    const body = parse(z.object({ mfaToken: z.string().min(10), code: z.string().regex(/^\d{6}$/) }).strict(), req.body);
    return { tokens: await s.auth.verifyMfa(body.mfaToken, body.code, meta(req)) };
  });

  // Enrollment: a full session (patients opting in) or a mfa_setup token (doctors/admins on first login).
  app.post("/v1/auth/mfa/setup", { config: authLimit, preHandler: guard(undefined, ["access", "mfa_setup"]) }, async (req) => s.auth.mfaSetup(ctxOf(req).actor.id));

  app.post("/v1/auth/mfa/activate", { config: authLimit, preHandler: guard(undefined, ["access", "mfa_setup"]) }, async (req) => {
    const body = parse(z.object({ code: z.string().regex(/^\d{6}$/) }).strict(), req.body);
    return s.auth.mfaActivate(ctxOf(req).actor.id, body.code, req.tokenKind === "mfa_setup", meta(req));
  });

  app.post("/v1/auth/refresh", { config: authLimit }, async (req) => {
    const body = parse(z.object({ refreshToken: z.string().min(20).max(200) }).strict(), req.body);
    return s.auth.refresh(body.refreshToken);
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const body = parse(z.object({ refreshToken: z.string().min(20).max(200) }).strict(), req.body);
    await s.auth.logout(body.refreshToken);
    return reply.status(204).send();
  });

  app.get("/v1/me", { preHandler: guard() }, async (req) => {
    const { actor } = ctxOf(req);
    const { rows } = await d.db.query(
      `SELECT u.id, u.email, u.role, u.mfa_enabled, p.full_name, p.phone_enc FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`,
      [actor.id],
    );
    const r = rows[0];
    if (!r) throw notFound("User");
    return { id: r.id, email: r.email, role: r.role, mfaEnabled: r.mfa_enabled, fullName: r.full_name, phone: r.phone_enc ? d.cipher.decrypt(r.phone_enc, `profiles.phone:${r.id}`) : null };
  });
}
