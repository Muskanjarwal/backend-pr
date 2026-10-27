import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../../deps.js";
import { parse, uuid } from "../../lib/validate.js";
import { ctxOf, makeAuthGuards } from "../../plugins/auth.js";
import type { Services } from "../../container.js";

export function paymentRoutes(app: FastifyInstance, d: Deps, s: Services): void {
  const { guard } = makeAuthGuards(s.auth.tokens);

  // Unauthenticated by design (the PSP has no user session) — authenticity comes from the HMAC signature.
  app.post("/v1/payments/webhook", async (req) => {
    s.payments.verifySignature(req.rawBody, req.headers["x-signature"] as string | undefined);
    return s.payments.handleWebhook(req.body);
  });

  app.get("/v1/payments/:id", { preHandler: guard("payment:read") }, async (req) => s.payments.get(ctxOf(req), parse(z.object({ id: uuid }), req.params).id));
}
