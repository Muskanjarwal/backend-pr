import type { Deps } from "../../deps.js";
import { badRequest } from "../../lib/errors.js";

const DAY_MS = 86_400_000;

export class AnalyticsService {
  constructor(private readonly d: Deps) {}

  /**
   * Recomputes per-day/per-specialty rollups for [from, to). Idempotent upsert, so it is safe to run on a timer and to
   * re-run for any range after a correction. Dashboards read daily_stats and never scan consultations.
   */
  async refresh(from: Date, to: Date): Promise<number> {
    const r = await this.d.db.query(
      `INSERT INTO daily_stats (day, specialty, booked, completed, cancelled, revenue_minor, refreshed_at)
       SELECT (c.scheduled_start AT TIME ZONE 'UTC')::date AS day, d.specialty,
              count(*) FILTER (WHERE c.status IN ('confirmed','in_progress','completed','no_show'))::int,
              count(*) FILTER (WHERE c.status = 'completed')::int,
              count(*) FILTER (WHERE c.status = 'cancelled')::int,
              COALESCE(sum(p.amount_minor) FILTER (WHERE c.status = 'completed' AND p.status = 'succeeded'), 0),
              $3
       FROM consultations c
       JOIN doctors d ON d.user_id = c.doctor_id
       LEFT JOIN LATERAL (SELECT amount_minor, status FROM payments WHERE consultation_id = c.id ORDER BY created_at DESC LIMIT 1) p ON true
       WHERE c.scheduled_start >= $1 AND c.scheduled_start < $2 AND c.status NOT IN ('pending_payment','expired')
       GROUP BY 1, 2
       ON CONFLICT (day, specialty) DO UPDATE SET booked = EXCLUDED.booked, completed = EXCLUDED.completed,
         cancelled = EXCLUDED.cancelled, revenue_minor = EXCLUDED.revenue_minor, refreshed_at = EXCLUDED.refreshed_at`,
      [from, to, this.d.clock.now()],
    );
    return r.rowCount;
  }

  /** Default rolling window used by the cron job: yesterday through the next 7 days, to catch late status changes. */
  async refreshRecent(): Promise<number> {
    const midnight = new Date(Math.floor(this.d.clock.now().getTime() / DAY_MS) * DAY_MS);
    return this.refresh(new Date(midnight.getTime() - 2 * DAY_MS), new Date(midnight.getTime() + 8 * DAY_MS));
  }

  async summary(from: Date, to: Date) {
    if (to <= from) throw badRequest("'to' must be after 'from'");
    if (to.getTime() - from.getTime() > 366 * DAY_MS) throw badRequest("Range may not exceed 366 days");
    const { rows } = await this.d.db.query<{ day: Date; specialty: string; booked: number; completed: number; cancelled: number; revenue_minor: string }>(
      `SELECT day, specialty, booked, completed, cancelled, revenue_minor::text AS revenue_minor
       FROM daily_stats WHERE day >= $1::date AND day < $2::date ORDER BY day, specialty`,
      [from, to],
    );
    const byDay = rows.map((r) => ({
      day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
      specialty: r.specialty,
      booked: r.booked,
      completed: r.completed,
      cancelled: r.cancelled,
      revenueMinor: Number(r.revenue_minor),
    }));
    const totals = byDay.reduce((t, r) => ({ booked: t.booked + r.booked, completed: t.completed + r.completed, cancelled: t.cancelled + r.cancelled, revenueMinor: t.revenueMinor + r.revenueMinor }), { booked: 0, completed: 0, cancelled: 0, revenueMinor: 0 });
    return { from, to, totals, byDay };
  }

  async doctorUtilization(from: Date, to: Date, limit: number) {
    const { rows } = await this.d.db.query(
      `SELECT d.user_id AS doctor_id, p.full_name, d.specialty,
              count(*) FILTER (WHERE s.status IN ('booked'))::int AS booked_slots, count(*)::int AS total_slots
       FROM doctors d JOIN profiles p ON p.user_id = d.user_id
       JOIN availability_slots s ON s.doctor_id = d.user_id AND s.starts_at >= $1 AND s.starts_at < $2 AND s.status <> 'cancelled'
       GROUP BY d.user_id, p.full_name, d.specialty ORDER BY booked_slots DESC, p.full_name LIMIT $3`,
      [from, to, limit],
    );
    return { items: rows.map((r) => ({ doctorId: r.doctor_id, fullName: r.full_name, specialty: r.specialty, bookedSlots: r.booked_slots, totalSlots: r.total_slots, utilization: r.total_slots ? +(r.booked_slots / r.total_slots).toFixed(3) : 0 })) };
  }
}
