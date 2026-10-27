import { randomUUID } from "node:crypto";
import type { Deps } from "../../deps.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { decodeCursor, encodeCursor } from "../../lib/validate.js";
import type { Ctx } from "../auth/rbac.js";

export interface DoctorSearch {
  specialty?: string;
  q?: string;
  language?: string;
  maxFeeMinor?: number;
  availableFrom?: Date;
  availableTo?: Date;
  limit: number;
  cursor?: string;
}

export interface SlotWindow {
  start: Date;
  end: Date;
}

const MAX_SLOTS_PER_REQUEST = 500;
const MAX_HORIZON_DAYS = 90;
const DOCTOR_CACHE_TTL = 30;
const SLOT_CACHE_TTL = 5;

const toDoctor = (r: any) => ({
  id: r.id,
  fullName: r.full_name,
  specialty: r.specialty,
  yearsExperience: r.years_experience,
  languages: r.languages,
  bio: r.bio,
  feeMinor: r.fee_minor,
  currency: r.currency,
  ...(r.verification_status ? { verificationStatus: r.verification_status } : {}),
});

const SELECT_DOCTOR = `SELECT d.user_id AS id, p.full_name, d.specialty, d.years_experience, d.languages, d.bio, d.fee_minor, d.currency, d.verification_status
  FROM doctors d JOIN profiles p ON p.user_id = d.user_id JOIN users u ON u.id = d.user_id`;

export class DoctorService {
  constructor(private readonly d: Deps) {}

  async search(s: DoctorSearch) {
    // Search results are cached briefly, keyed by the full query + a version that slot/profile writes bump.
    const ver = await this.d.readThrough.version("doctors");
    const key = `doctors:search:${ver}:${JSON.stringify([s.specialty, s.q, s.language, s.maxFeeMinor, s.availableFrom, s.availableTo, s.limit, s.cursor])}`;
    return this.d.readThrough.get("doctor_search", key, DOCTOR_CACHE_TTL, () => this.searchUncached(s));
  }

  private async searchUncached(s: DoctorSearch) {
    const where = [`d.verification_status = 'verified'`, `u.status = 'active'`];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => (params.push(v), where.push(sql.replaceAll("?", `$${params.length}`)));
    if (s.specialty) add("d.specialty = ?", s.specialty.toLowerCase());
    if (s.q) add("lower(p.full_name) LIKE lower(?) || '%'", s.q.replace(/[\\%_]/g, "\\$&"));
    if (s.language) add("? = ANY(d.languages)", s.language);
    if (s.maxFeeMinor !== undefined) add("d.fee_minor <= ?", s.maxFeeMinor);
    if (s.availableFrom || s.availableTo) {
      const from = s.availableFrom ?? this.d.clock.now();
      const to = s.availableTo ?? new Date(from.getTime() + 14 * 86_400_000);
      params.push(from, to);
      where.push(`EXISTS (SELECT 1 FROM availability_slots s WHERE s.doctor_id = d.user_id AND s.status = 'open'
                           AND s.starts_at >= $${params.length - 1} AND s.starts_at < $${params.length})`);
    }
    const cursor = decodeCursor<[string, string]>(s.cursor);
    if (cursor) {
      params.push(cursor[0], cursor[1]);
      where.push(`(lower(p.full_name), d.user_id) > ($${params.length - 1}, $${params.length}::uuid)`);
    }
    params.push(s.limit + 1);
    const { rows } = await this.d.db.query(
      `${SELECT_DOCTOR} WHERE ${where.join(" AND ")} ORDER BY lower(p.full_name), d.user_id LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, s.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => {
        const { verificationStatus: _omit, ...pub } = toDoctor(r);
        return pub;
      }),
      nextCursor: rows.length > s.limit && last ? encodeCursor([String(last.full_name).toLowerCase(), last.id]) : null,
    };
  }

  async get(id: string, ctx: Ctx) {
    const row = await this.d.readThrough.get("doctor_profile", `doctor:${await this.d.readThrough.version("doctors")}:${id}`, DOCTOR_CACHE_TTL, async () => {
      const { rows } = await this.d.db.query(`${SELECT_DOCTOR} WHERE d.user_id = $1 AND u.status = 'active'`, [id]);
      return rows[0] ?? null;
    });
    // Unverified profiles are visible to their owner and admins only.
    if (!row || (row.verification_status !== "verified" && ctx.actor.role !== "admin" && ctx.actor.id !== id)) throw notFound("Doctor");
    const { verificationStatus, ...pub } = toDoctor(row);
    return ctx.actor.role === "admin" || ctx.actor.id === id ? { ...pub, verificationStatus } : pub;
  }

  async updateProfile(ctx: Ctx, patch: Partial<{ specialty: string; bio: string; languages: string[]; feeMinor: number; yearsExperience: number }>) {
    const sets: string[] = [];
    const params: unknown[] = [ctx.actor.id];
    const col = (name: string, v: unknown) => (params.push(v), sets.push(`${name} = $${params.length}`));
    if (patch.specialty !== undefined) col("specialty", patch.specialty.toLowerCase());
    if (patch.bio !== undefined) col("bio", patch.bio);
    if (patch.languages !== undefined) col("languages", patch.languages);
    if (patch.feeMinor !== undefined) col("fee_minor", patch.feeMinor);
    if (patch.yearsExperience !== undefined) col("years_experience", patch.yearsExperience);
    if (sets.length === 0) throw badRequest("No updatable fields supplied");
    col("updated_at", this.d.clock.now());

    await this.d.db.tx(async (q) => {
      const r = await q.query(`UPDATE doctors SET ${sets.join(", ")} WHERE user_id = $1`, params);
      if (r.rowCount === 0) throw notFound("Doctor profile");
      await this.d.audit.record(q, { actorId: ctx.actor.id, actorRole: ctx.actor.role, action: "doctor.profile_update", entityType: "doctor", entityId: ctx.actor.id, ip: ctx.ip, requestId: ctx.requestId, metadata: { fields: Object.keys(patch) } });
    });
    await this.d.readThrough.bump("doctors");
    return this.get(ctx.actor.id, ctx);
  }

  async createSlots(ctx: Ctx, windows: SlotWindow[], slotMinutes: number) {
    const now = this.d.clock.now();
    const horizon = new Date(now.getTime() + MAX_HORIZON_DAYS * 86_400_000);
    const stepMs = slotMinutes * 60_000;
    const starts: Date[] = [];
    for (const w of windows) {
      if (w.end <= w.start) throw badRequest("Window end must be after start");
      if (w.start < now) throw badRequest("Availability must be in the future");
      if (w.end > horizon) throw badRequest(`Availability can be published at most ${MAX_HORIZON_DAYS} days ahead`);
      for (let t = w.start.getTime(); t + stepMs <= w.end.getTime(); t += stepMs) starts.push(new Date(t));
      if (starts.length > MAX_SLOTS_PER_REQUEST) throw badRequest(`At most ${MAX_SLOTS_PER_REQUEST} slots per request`);
    }
    if (starts.length === 0) throw badRequest("Windows are shorter than one slot");

    const created = await this.d.db.tx(async (q) => {
      // Locking the doctor row serializes concurrent publishes for one doctor, so the overlap check below can't race.
      const doc = await q.query<{ verification_status: string }>(`SELECT verification_status FROM doctors WHERE user_id = $1 FOR UPDATE`, [ctx.actor.id]);
      if (!doc.rows[0]) throw notFound("Doctor profile");
      if (doc.rows[0].verification_status !== "verified") throw forbidden("Doctor is not verified yet", "DOCTOR_NOT_VERIFIED");

      const res = await q.query<{ id: string }>(
        `INSERT INTO availability_slots (id, doctor_id, starts_at, ends_at, created_at, updated_at)
         SELECT x.id, $1, x.s, x.e, $5, $5 FROM unnest($2::uuid[], $3::timestamptz[], $4::timestamptz[]) AS x(id, s, e)
         WHERE NOT EXISTS (SELECT 1 FROM availability_slots a WHERE a.doctor_id = $1 AND a.status <> 'cancelled'
                             AND a.starts_at < x.e AND a.ends_at > x.s)
         RETURNING id`,
        [ctx.actor.id, starts.map(() => randomUUID()), starts, starts.map((s) => new Date(s.getTime() + stepMs)), now],
      );
      await this.d.audit.record(q, { actorId: ctx.actor.id, actorRole: ctx.actor.role, action: "slot.create", entityType: "doctor", entityId: ctx.actor.id, ip: ctx.ip, requestId: ctx.requestId, metadata: { requested: starts.length, created: res.rowCount } });
      return res.rowCount;
    });
    await this.invalidate(ctx.actor.id);
    return { requested: starts.length, created, skippedOverlapping: starts.length - created };
  }

  async listSlots(doctorId: string, from: Date | undefined, to: Date | undefined) {
    const now = this.d.clock.now();
    const start = from ?? new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const end = to ?? new Date(start.getTime() + 14 * 86_400_000);
    if (end <= start) throw badRequest("'to' must be after 'from'");
    if (end.getTime() - start.getTime() > 31 * 86_400_000) throw badRequest("Range may not exceed 31 days");

    const ver = await this.d.readThrough.version(`slots:${doctorId}`);
    return this.d.readThrough.get("slots", `slots:${doctorId}:${ver}:${start.toISOString()}:${end.toISOString()}`, SLOT_CACHE_TTL, async () => {
      const { rows } = await this.d.db.query(
        // Expired holds count as open: the sweeper job will release them, but readers shouldn't have to wait for it.
        `SELECT id, starts_at, ends_at FROM availability_slots
         WHERE doctor_id = $1 AND starts_at >= $2 AND starts_at < $3
           AND (status = 'open' OR (status = 'held' AND held_until <= $4))
         ORDER BY starts_at`,
        [doctorId, start, end, now],
      );
      return { items: rows.map((r) => ({ id: r.id, startsAt: r.starts_at, endsAt: r.ends_at })) };
    });
  }

  async cancelSlot(ctx: Ctx, slotId: string) {
    const r = await this.d.db.tx(async (q) => {
      const res = await q.query(
        `UPDATE availability_slots SET status = 'cancelled', updated_at = $3 WHERE id = $1 AND doctor_id = $2 AND status = 'open'`,
        [slotId, ctx.actor.id, this.d.clock.now()],
      );
      if (res.rowCount === 0) {
        const exists = await q.query(`SELECT 1 FROM availability_slots WHERE id = $1 AND doctor_id = $2`, [slotId, ctx.actor.id]);
        throw exists.rowCount ? conflict("SLOT_NOT_OPEN", "Only open slots can be withdrawn; cancel the consultation instead") : notFound("Slot");
      }
      await this.d.audit.record(q, { actorId: ctx.actor.id, actorRole: ctx.actor.role, action: "slot.cancel", entityType: "slot", entityId: slotId, ip: ctx.ip, requestId: ctx.requestId });
    });
    await this.invalidate(ctx.actor.id);
    return r;
  }

  async setVerification(ctx: Ctx, doctorId: string, status: "verified" | "rejected") {
    await this.d.db.tx(async (q) => {
      const r = await q.query(`UPDATE doctors SET verification_status = $2, verified_at = $3, updated_at = $3 WHERE user_id = $1`, [doctorId, status, this.d.clock.now()]);
      if (r.rowCount === 0) throw notFound("Doctor");
      await this.d.audit.record(q, { actorId: ctx.actor.id, actorRole: ctx.actor.role, action: `doctor.${status}`, entityType: "doctor", entityId: doctorId, ip: ctx.ip, requestId: ctx.requestId });
    });
    await this.d.readThrough.bump("doctors");
  }

  async listForAdmin(status: "pending" | "verified" | "rejected", limit: number) {
    const { rows } = await this.d.db.query(`${SELECT_DOCTOR} WHERE d.verification_status = $1 ORDER BY d.created_at LIMIT $2`, [status, limit]);
    return { items: rows.map(toDoctor) };
  }

  /**
   * Called whenever a doctor's slot inventory changes. Only the per-doctor slot list is invalidated; search results
   * (which can filter on availability) are allowed to be up to DOCTOR_CACHE_TTL stale, because booking itself always
   * re-checks the slot in the database. Bumping the global "doctors" family on every booking would zero the hit rate.
   */
  async invalidate(doctorId: string): Promise<void> {
    await this.d.readThrough.bump(`slots:${doctorId}`);
  }
}
