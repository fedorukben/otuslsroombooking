import { db, type Queryable } from "./db.js";
import type { AdminUser } from "./auth.js";

export type Actor =
  | { type: "admin"; admin: Pick<AdminUser, "id" | "name">; ip: string }
  | { type: "member"; name: string; ip: string }
  | { type: "system"; name?: string; ip?: string };

export const adminActor = (admin: AdminUser, ip: string): Actor => ({ type: "admin", admin, ip });
export const memberActor = (name: string, ip: string): Actor => ({ type: "member", name, ip });

/**
 * Records an entry in the activity log. Never throws: a logging failure must not break the action itself
 * (when called inside a transaction, a failed insert would abort it, so the insert is kept simple).
 */
export async function logActivity(
  entry: { teamId: number | null; action: string; summary: string; details?: unknown; actor: Actor },
  client: Queryable = db(),
) {
  const a = entry.actor;
  try {
    await client.query(
      `INSERT INTO activity_log (team_id, team_name, actor_type, admin_id, actor_name, ip, action, summary, details)
       VALUES ($1, COALESCE((SELECT name FROM teams WHERE id = $1), ''), $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.teamId,
        a.type,
        a.type === "admin" ? a.admin.id : null,
        a.type === "admin" ? a.admin.name : a.type === "member" ? a.name : a.name ?? "",
        a.ip ?? "",
        entry.action,
        entry.summary.slice(0, 500),
        entry.details === undefined ? null : JSON.stringify(entry.details),
      ],
    );
  } catch (err) {
    console.error("activity log failed", err);
  }
}
