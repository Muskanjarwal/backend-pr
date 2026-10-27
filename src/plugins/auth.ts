import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { forbidden, unauthorized } from "../lib/errors.js";
import { can, type Actor, type Ctx, type Permission } from "../modules/auth/rbac.js";
import type { TokenKind, TokenService } from "../modules/auth/tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    actor?: Actor;
    tokenKind?: TokenKind;
    rawBody?: string;
  }
}

export function makeAuthGuards(tokens: TokenService) {
  /** Verifies the bearer token and requires `permission` (when given). Default accepts full sessions only. */
  const guard =
    (permission?: Permission, kinds: readonly TokenKind[] = ["access"]): preHandlerAsyncHookHandler =>
    async (req: FastifyRequest, _reply: FastifyReply) => {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) throw unauthorized();
      const claims = await tokens.verify(header.slice(7), kinds);
      req.actor = { id: claims.sub, role: claims.role };
      req.tokenKind = claims.kind;
      if (permission && !can(claims.role, permission)) throw forbidden();
    };
  return { guard };
}

export function ctxOf(req: FastifyRequest): Ctx {
  if (!req.actor) throw unauthorized();
  return { actor: req.actor, ip: req.ip, requestId: req.id };
}
