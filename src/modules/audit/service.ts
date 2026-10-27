import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "../../db/types.js";
import type { Clock } from "../../lib/clock.js";
import { Keyring, hmacHex, safeEqual } from "../../lib/crypto.js";

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  ip?: string | null;
  requestId?: string | null;
  /** Never put PII/PHI here — ids and state names only. */
  metadata?: Record<string, unknown>;
}

export interface AuditFilter {
  actorId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: { occurredAt: string; id: string };
}

interface Stored {
  id: string;
  occurred_at: Date;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  ip: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
  sig_version: number;
  signature: string;
}

export class AuditService {
  constructor(
    private readonly keys: Keyring,
    private readonly clock: Clock,
  ) {}

  private canonical(r: Pick<Stored, "id" | "actor_id" | "actor_role" | "action" | "entity_type" | "entity_id" | "metadata"> & { occurred_at: Date }): string {
    return JSON.stringify([r.id, r.occurred_at.toISOString(), r.actor_id, r.actor_role, r.action, r.entity_type, r.entity_id, r.metadata]);
  }

  /** Pass the caller's transaction so the audit row commits atomically with the change it describes. */
  async record(q: Queryable, e: AuditEntry): Promise<void> {
    const row = {
      id: randomUUID(),
      occurred_at: this.clock.now(),
      actor_id: e.actorId ?? null,
      actor_role: e.actorRole ?? null,
      action: e.action,
      entity_type: e.entityType,
      entity_id: e.entityId ?? null,
      metadata: e.metadata ?? {},
    };
    const signature = hmacHex(this.keys.current(), this.canonical(row));
    await q.query(
      `INSERT INTO audit_logs (id, occurred_at, actor_id, actor_role, action, entity_type, entity_id, ip, request_id, metadata, sig_version, signature)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [row.id, row.occurred_at, row.actor_id, row.actor_role, row.action, row.entity_type, row.entity_id, e.ip ?? null, e.requestId ?? null,
       JSON.stringify(row.metadata), this.keys.currentVersion, signature],
    );
  }

  async search(db: Db, f: AuditFilter, verify: boolean) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => (params.push(v), where.push(sql.replace("?", `$${params.length}`)));
    if (f.actorId) add("actor_id = ?", f.actorId);
    if (f.entityType) add("entity_type = ?", f.entityType);
    if (f.entityId) add("entity_id = ?", f.entityId);
    if (f.action) add("action = ?", f.action);
    if (f.from) add("occurred_at >= ?", f.from);
    if (f.to) add("occurred_at < ?", f.to);
    if (f.cursor) {
      params.push(f.cursor.occurredAt, f.cursor.id);
      where.push(`(occurred_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(f.limit + 1);
    const { rows } = await db.query<Stored>(
      `SELECT * FROM audit_logs ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY occurred_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, f.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        occurredAt: r.occurred_at,
        actorId: r.actor_id,
        actorRole: r.actor_role,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        ip: r.ip,
        requestId: r.request_id,
        metadata: r.metadata,
        ...(verify ? { signatureValid: this.verify(r) } : {}),
      })),
      nextCursor: rows.length > f.limit && last ? { occurredAt: last.occurred_at.toISOString(), id: last.id } : null,
    };
  }

  verify(r: Stored): boolean {
    try {
      return safeEqual(hmacHex(this.keys.get(r.sig_version), this.canonical(r)), r.signature);
    } catch {
      return false;
    }
  }
}
