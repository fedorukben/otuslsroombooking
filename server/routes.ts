import { DateTime, IANAZone } from "luxon";
import type { ManageView, WeeklyHours } from "../shared/types.js";
import type { ActivityEntry, AdminAccount } from "../shared/types.js";
import { adminActor, logActivity, memberActor } from "./activity.js";
import { type AdminUser, clearCookie, currentAccount, hashPin, requireAccount, requireAdmin, requireSuper, requireTeamAdmin, sessionCookie } from "./auth.js";
import { cancelSeries, createBooking, editSeries, findFree, preview, previewEdit, seriesBookings, type SeriesRow } from "./bookings.js";
import { buildCalendar, type FeedEvent } from "./ics.js";
import { hashPassword, randomToken, safeEqual, verifyPassword } from "./crypto.js";
import { one, q, tx } from "./db.js";
import { bad, body, bool, color, HttpError, int, isoDate, json, notFound, Router, str, type RouteContext } from "./http.js";
import * as map from "./mappers.js";
import type { BookingRow, RoomRow, TeamRow } from "./mappers.js";
import { rateLimit } from "./rateLimit.js";
import { activePeopleNames, applyPeopleList, ensurePerson, type PersonRow } from "./people.js";
import { createToken, openToken, revokeOpen, useToken, type TokenRow } from "./tokens.js";

export const router = new Router();

// =====================================================================
// Shared helpers
// =====================================================================

const SLOT_CHOICES = [5, 10, 15, 20, 30, 60];

function parseHours(raw: unknown): WeeklyHours {
  if (!raw || typeof raw !== "object") throw bad("Opening hours are missing.");
  const out: WeeklyHours = {};
  for (let d = 1; d <= 7; d++) {
    const list = (raw as Record<string, unknown>)[String(d)] ?? [];
    if (!Array.isArray(list)) throw bad("Opening hours are malformed.");
    const ranges = list.map((r) => {
      if (!Array.isArray(r) || r.length !== 2) throw bad("Opening hours are malformed.");
      const a = Number(r[0]);
      const b = Number(r[1]);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b > 1440 || a >= b) {
        throw bad("Each opening-hours range must end after it starts.");
      }
      return [a, b] as [number, number];
    });
    ranges.sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i][0] < ranges[i - 1][1]) throw bad("Opening-hours ranges on the same day can't overlap.");
    }
    out[String(d)] = ranges;
  }
  return out;
}

function parseRuleValues(raw: any, nullable: boolean) {
  const n = (v: unknown, field: string, min: number, max: number) => int(v, field, { min, max, nullable });
  const slot = n(raw.slotMinutes, "Time step", 5, 60);
  if (slot !== null && !SLOT_CHOICES.includes(slot)) throw bad(`Time step must be one of ${SLOT_CHOICES.join(", ")} minutes.`);
  const minM = n(raw.minMinutes, "Minimum length", 5, 1440);
  const maxM = n(raw.maxMinutes, "Maximum length", 5, 1440);
  if (minM !== null && maxM !== null && maxM < minM) throw bad("Maximum length must be at least the minimum length.");
  const cap = raw.capacityMode;
  if (cap !== undefined && cap !== null && cap !== "" && cap !== "warn" && cap !== "block") throw bad("Capacity rule must be warn or block.");
  return {
    slot_minutes: slot,
    min_minutes: minM,
    max_minutes: maxM,
    max_days_ahead: n(raw.maxDaysAhead, "Booking window", 1, 730),
    buffer_minutes: n(raw.bufferMinutes, "Buffer", 0, 240),
    capacity_mode: cap === "" || cap === undefined ? (nullable ? null : "warn") : cap,
  };
}

async function teamById(id: number): Promise<TeamRow> {
  const t = await one<TeamRow>("SELECT * FROM teams WHERE id = $1", [id]);
  if (!t) throw notFound("Team not found.");
  return t;
}

async function teamRooms(team: TeamRow, activeOnly: boolean) {
  const rows = await q<RoomRow>(
    `SELECT * FROM rooms WHERE team_id = $1 ${activeOnly ? "AND active" : ""} ORDER BY sort_order, campus, building, name`,
    [team.id],
  );
  return rows.map((r) => map.room(r, team));
}

async function teamCategories(teamId: number, activeOnly: boolean) {
  const rows = await q(
    `SELECT * FROM categories WHERE team_id = $1 ${activeOnly ? "AND active" : ""} ORDER BY sort_order, name`,
    [teamId],
  );
  return rows.map(map.category);
}

async function events(team: TeamRow, url: URL, admin: boolean) {
  const start = DateTime.fromISO(url.searchParams.get("start") ?? "");
  const end = DateTime.fromISO(url.searchParams.get("end") ?? "");
  if (!start.isValid || !end.isValid || end <= start) throw bad("A valid start and end are required.");
  if (end.diff(start, "days").days > 120) throw bad("Ask for at most 120 days at a time.");
  const roomId = url.searchParams.get("roomId");
  const params: unknown[] = [team.id, start.toJSDate(), end.toJSDate()];
  let roomFilter = "";
  if (roomId) {
    params.push(Number(roomId));
    roomFilter = `AND b.room_id = $${params.length}`;
  }
  const rows = await q<BookingRow>(
    `SELECT b.*, (s.recurrence IS NOT NULL) AS recurring
       FROM bookings b JOIN booking_series s ON s.id = b.series_id
      WHERE b.team_id = $1 AND b.status <> 'cancelled' AND b.starts_at < $3 AND b.ends_at > $2 ${roomFilter}
      ORDER BY b.starts_at`,
    params,
  );
  const closures = await q(
    "SELECT * FROM closures WHERE team_id = $1 AND end_date >= $2::date AND start_date <= $3::date ORDER BY start_date",
    [team.id, start.setZone(team.timezone).toISODate(), end.setZone(team.timezone).toISODate()],
  );
  return json({
    bookings: rows.map((b) => map.calendarBooking(b, { admin })),
    closures: closures.map(map.closure),
  });
}

// =====================================================================
// Admin: setup, sign-in, admin accounts
// =====================================================================

router.get("/admin/status", async ({ req }) => {
  const count = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM admins");
  const account = await currentAccount(req);
  const admin = account?.isAdmin ? account : null;
  return json({
    needsSetup: count!.n === 0,
    setupKeyConfigured: !!process.env.ADMIN_SETUP_KEY,
    admin,
    account,
    transfer: admin ? await transferFor(admin) : null,
  });
});

router.post("/admin/setup", async ({ req, ip }) => {
  await rateLimit(`setup:${ip}`, 10, 900);
  const b = await body(req);
  const key = process.env.ADMIN_SETUP_KEY;
  if (!key) throw bad("Set the ADMIN_SETUP_KEY environment variable in Netlify first, then redeploy.");
  if (!safeEqual(String(b.setupKey ?? ""), key)) throw new HttpError(403, "The setup key is wrong.");
  const count = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM admins");
  if (count!.n > 0) throw new HttpError(409, "Setup is already done. Sign in instead.");
  // The first account is the one and only super admin.
  const admin = await createAdmin(b, true);
  await q("UPDATE admins SET last_login_at = NOW() WHERE id = $1", [admin.id]);
  await logActivity({ teamId: null, action: "admin.setup", summary: `Super admin account created for ${admin.name} (${admin.email})`, actor: adminActor(admin, ip) });
  return json({ admin }, 201, { "set-cookie": await sessionCookie(admin.id, req) });
});

async function createAdmin(b: any, isSuper = false): Promise<AdminUser> {
  const email = str(b.email, "Email", { required: true, max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad("Email doesn't look right.");
  const name = str(b.name, "Name", { required: true, max: 120 });
  const password = String(b.password ?? "");
  if (password.length < 10) throw bad("Password must be at least 10 characters.");
  return (await one<AdminUser>(
    `INSERT INTO admins (email, name, password_hash, is_super) VALUES ($1, $2, $3, $4)
     RETURNING id, email, name, is_super AS "isSuper", is_admin AS "isAdmin"`,
    [email, name, await hashPassword(password), isSuper],
  ))!;
}

router.post("/admin/login", async ({ req, ip }) => {
  await rateLimit(`login:${ip}`, 10, 900, "Too many sign-in attempts. Wait 15 minutes and try again.");
  const b = await body(req);
  const email = String(b.email ?? "").trim().toLowerCase();
  const row = await one<{ id: number; email: string; name: string; password_hash: string; is_super: boolean }>(
    "SELECT * FROM admins WHERE email = $1",
    [email],
  );
  const ok = row ? await verifyPassword(String(b.password ?? ""), row.password_hash) : false;
  if (!row || !ok) {
    await logActivity({ teamId: null, action: "admin.login_failed", summary: `Failed sign-in for ${email.slice(0, 120) || "(blank)"}`, actor: { type: "system", name: email.slice(0, 120), ip } });
    throw new HttpError(401, "Email or password is incorrect.");
  }
  await q("UPDATE admins SET last_login_at = NOW() WHERE id = $1", [row.id]);
  const admin = { id: row.id, email: row.email, name: row.name, isSuper: row.is_super, isAdmin: (row as any).is_admin as boolean };
  await logActivity({ teamId: null, action: "admin.login", summary: `${row.name} signed in${admin.isAdmin ? "" : " (staff)"}`, actor: adminActor(admin, ip) });
  return json({ admin }, 200, { "set-cookie": await sessionCookie(row.id, req) });
});

router.post("/admin/logout", async () => json({ ok: true }, 200, { "set-cookie": clearCookie() }));

router.get("/admin/admins", async ({ req }) => {
  await requireSuper(req);
  const rows = await q<{ id: number; email: string; name: string; is_super: boolean; created_at: Date; last_login_at: Date | null; team_ids: number[] }>(
    `SELECT a.*, COALESCE(array_agg(ta.team_id) FILTER (WHERE ta.team_id IS NOT NULL), '{}') AS team_ids
       FROM admins a LEFT JOIN team_admins ta ON ta.admin_id = a.id
      WHERE a.is_admin
      GROUP BY a.id ORDER BY a.is_super DESC, a.name`,
  );
  const admins: AdminAccount[] = rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    isSuper: r.is_super,
    teamIds: r.team_ids,
    createdAt: new Date(r.created_at).toISOString(),
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
  }));
  return json({ admins });
});

async function setAdminTeams(adminId: number, raw: unknown): Promise<string[]> {
  const ids = (Array.isArray(raw) ? raw : []).map(Number).filter(Number.isInteger);
  const teams = await q<{ id: number; name: string }>("SELECT id, name FROM teams WHERE id = ANY($1::int[])", [ids]);
  await q("DELETE FROM team_admins WHERE admin_id = $1", [adminId]);
  const a = await one<{ name: string; email: string }>("SELECT name, email FROM admins WHERE id = $1", [adminId]);
  for (const t of teams) {
    await q("INSERT INTO team_admins (admin_id, team_id) VALUES ($1, $2)", [adminId, t.id]);
    if (a) await ensurePerson(t.id, a.name, a.email, adminId);
  }
  return teams.map((t) => t.name);
}

router.post("/admin/admins", async ({ req, ip }) => {
  const me = await requireSuper(req);
  const b = await body(req);
  const admin = await createAdmin(b);
  const teamNames = await setAdminTeams(admin.id, b.teamIds);
  await logActivity({
    teamId: null,
    action: "admin.add",
    summary: `Added admin ${admin.name} (${admin.email})${teamNames.length ? ` for ${teamNames.join(", ")}` : " with no teams yet"}`,
    actor: adminActor(me, ip),
  });
  return json({ admin }, 201);
});

router.patch("/admin/admins/:id/teams", async ({ req, params, ip }) => {
  const me = await requireSuper(req);
  const target = await one<{ id: number; name: string; is_super: boolean }>("SELECT id, name, is_super FROM admins WHERE id = $1 AND is_admin", [Number(params.id)]);
  if (!target) throw notFound("Admin not found.");
  if (target.is_super) throw bad("The super admin already manages every team.");
  const b = await body(req);
  const names = await setAdminTeams(target.id, b.teamIds);
  await logActivity({ teamId: null, action: "admin.teams", summary: `${target.name} now manages: ${names.join(", ") || "no teams"}`, actor: adminActor(me, ip) });
  return json({ ok: true });
});

router.delete("/admin/admins/:id", async ({ req, params, ip }) => {
  const me = await requireSuper(req);
  const id = Number(params.id);
  if (id === me.id) throw bad("You can't remove your own account.");
  const row = await one<{ name: string; email: string }>("DELETE FROM admins WHERE id = $1 AND is_admin RETURNING name, email", [id]);
  if (row) await logActivity({ teamId: null, action: "admin.remove", summary: `Removed admin ${row.name} (${row.email})`, actor: adminActor(me, ip) });
  return json({ ok: true });
});

router.post("/admin/password", async ({ req, ip }) => {
  const me = await requireAccount(req);
  const b = await body(req);
  const row = await one<{ password_hash: string }>("SELECT password_hash FROM admins WHERE id = $1", [me.id]);
  if (!(await verifyPassword(String(b.currentPassword ?? ""), row!.password_hash))) {
    throw bad("Your current password is incorrect.");
  }
  const next = String(b.newPassword ?? "");
  if (next.length < 10) throw bad("New password must be at least 10 characters.");
  await q("UPDATE admins SET password_hash = $1, session_version = session_version + 1 WHERE id = $2", [await hashPassword(next), me.id]);
  await logActivity({ teamId: null, action: "admin.password", summary: `${me.name} changed their password (other sessions signed out)`, actor: adminActor(me, ip) });
  return json({ ok: true }, 200, { "set-cookie": await sessionCookie(me.id, req) });
});

// =====================================================================
// Admin: activity log
// =====================================================================

router.get("/admin/activity", async ({ req, url }) => {
  const teamId = url.searchParams.get("teamId");
  if (teamId) await requireTeamAdmin(req, Number(teamId));
  else await requireSuper(req); // the all-teams log (including sign-ins and admin changes) is super-admin only
  const params: unknown[] = [];
  const where: string[] = [];
  if (teamId) {
    params.push(Number(teamId));
    where.push(`team_id = $${params.length}`);
  }
  const before = url.searchParams.get("before");
  if (before) {
    params.push(Number(before));
    where.push(`id < $${params.length}`);
  }
  const search = url.searchParams.get("q")?.trim();
  if (search) {
    params.push(`%${search.replace(/[%_]/g, "\\$&")}%`);
    where.push(`(summary ILIKE $${params.length} OR actor_name ILIKE $${params.length} OR team_name ILIKE $${params.length})`);
  }
  const type = url.searchParams.get("type");
  if (type) {
    params.push(`${type}.%`);
    where.push(`action LIKE $${params.length}`);
  }
  const rows = await q(
    `SELECT * FROM activity_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT 101`,
    params,
  );
  const entries: ActivityEntry[] = rows.slice(0, 100).map((r) => ({
    id: Number(r.id),
    teamId: r.team_id,
    teamName: r.team_name,
    actorType: r.actor_type,
    actorName: r.actor_name,
    ip: r.ip,
    action: r.action,
    summary: r.summary,
    createdAt: new Date(r.created_at).toISOString(),
  }));
  return json({ entries, more: rows.length > 100 });
});

// =====================================================================
// Admin: teams
// =====================================================================

router.get("/admin/teams", async ({ req }) => {
  const me = await requireAdmin(req);
  const rows = await q(
    `SELECT t.*,
       (SELECT COUNT(*) FROM rooms r WHERE r.team_id = t.id) AS room_count,
       (SELECT COUNT(*) FROM bookings b WHERE b.team_id = t.id AND b.status = 'pending' AND b.ends_at > NOW()) AS pending_count
     FROM teams t
     WHERE $1 OR EXISTS (SELECT 1 FROM team_admins ta WHERE ta.team_id = t.id AND ta.admin_id = $2)
     ORDER BY t.name`,
    [me.isSuper, me.id],
  );
  return json({ teams: rows.map(map.adminTeam) });
});

async function parseTeam(b: any, existing?: TeamRow) {
  const name = str(b.name ?? existing?.name, "Team name", { required: true, max: 120 });
  const timezone = String(b.timezone ?? existing?.timezone ?? "America/Toronto");
  if (!IANAZone.isValidZone(timezone)) throw bad("That time zone isn't recognised.");
  let logo = b.logoDataUrl === undefined ? existing?.logo_data_url ?? null : b.logoDataUrl || null;
  if (logo) {
    if (typeof logo !== "string" || !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo)) {
      throw bad("The logo must be a PNG, JPEG, WebP, GIF or SVG image.");
    }
    if (logo.length > 400_000) throw bad("The logo must be smaller than about 300 KB.");
  }
  const rules = parseRuleValues(
    {
      slotMinutes: b.rules?.slotMinutes ?? existing?.slot_minutes ?? 30,
      minMinutes: b.rules?.minMinutes ?? existing?.min_minutes ?? 30,
      maxMinutes: b.rules?.maxMinutes ?? existing?.max_minutes ?? 240,
      maxDaysAhead: b.rules?.maxDaysAhead ?? existing?.max_days_ahead ?? 120,
      bufferMinutes: b.rules?.bufferMinutes ?? existing?.buffer_minutes ?? 0,
      capacityMode: b.rules?.capacityMode ?? existing?.capacity_mode ?? "warn",
    },
    false,
  );
  const rf = b.requiredFields ?? {};
  return {
    name,
    description: str(b.description ?? existing?.description, "Description", { max: 1000 }),
    timezone,
    accent_color: color(b.accentColor ?? existing?.accent_color, "Accent colour"),
    logo_data_url: logo,
    ...rules,
    require_email: rf.email === undefined ? existing?.require_email ?? false : bool(rf.email),
    require_attendance: rf.attendance === undefined ? existing?.require_attendance ?? false : bool(rf.attendance),
    require_description: rf.description === undefined ? existing?.require_description ?? false : bool(rf.description),
    people_only: b.peopleOnly === undefined ? existing?.people_only ?? false : bool(b.peopleOnly),
    link_access: b.linkAccess === undefined ? existing?.link_access ?? true : bool(b.linkAccess),
    default_hours: b.defaultHours === undefined && existing ? existing.default_hours : parseHours(b.defaultHours ?? DEFAULT_HOURS),
  };
}

const DEFAULT_HOURS: WeeklyHours = { "1": [[510, 1020]], "2": [[510, 1020]], "3": [[510, 1020]], "4": [[510, 1020]], "5": [[510, 1020]], "6": [], "7": [] };

async function pinHashFrom(pin: unknown, existing: string | null): Promise<string | null> {
  if (pin === undefined) return existing;
  if (pin === null || pin === "") return null;
  const p = String(pin);
  if (!/^\d{4,8}$/.test(p)) throw bad("The PIN must be 4 to 8 digits.");
  return hashPin(p);
}

function upsertColumns(values: Record<string, unknown>) {
  const cols = Object.keys(values);
  return { cols, params: cols.map((c) => (c === "default_hours" || c === "hours" ? JSON.stringify(values[c]) : values[c])) };
}

/** Human list of which settings changed, for the activity log. */
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>, labels: Record<string, string>): string[] {
  return Object.keys(after)
    .filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
    .map((k) => labels[k] ?? k.replace(/_/g, " "));
}

const TEAM_LABELS: Record<string, string> = {
  logo_data_url: "logo",
  accent_color: "accent colour",
  default_hours: "default hours",
  slot_minutes: "time step",
  min_minutes: "shortest booking",
  max_minutes: "longest booking",
  max_days_ahead: "booking window",
  buffer_minutes: "buffer",
  capacity_mode: "capacity rule",
  require_email: "required email",
  require_attendance: "required attendance",
  require_description: "required description",
  pin_hash: "PIN",
  people_only: "people-list-only booking",
  link_access: "no-login team link",
};

router.post("/admin/teams", async ({ req, ip }) => {
  const me = await requireAdmin(req);
  const b = await body(req);
  const values = {
    ...(await parseTeam(b)),
    share_token: randomToken(12),
    feed_token: randomToken(24),
    admin_feed_token: randomToken(32),
    pin_hash: await pinHashFrom(b.pin, null),
  };
  const { cols, params } = upsertColumns(values);
  const row = await one<TeamRow>(
    `INSERT INTO teams (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
    params,
  );
  // Starter categories so the team is usable straight away.
  const starters: [string, string][] = [["Meeting", "#0b5cad"], ["Workshop", "#1a7f37"], ["Event", "#8250df"], ["Other", "#6e7781"]];
  for (const [i, [n, c]] of starters.entries()) {
    await q("INSERT INTO categories (team_id, name, color, sort_order) VALUES ($1, $2, $3, $4)", [row!.id, n, c, i]);
  }
  if (!me.isSuper) await q("INSERT INTO team_admins (admin_id, team_id) VALUES ($1, $2)", [me.id, row!.id]);
  await ensurePerson(row!.id, me.name, me.email, me.id);
  await logActivity({ teamId: row!.id, action: "team.create", summary: `Created team "${row!.name}"`, actor: adminActor(me, ip) });
  return json({ team: map.adminTeam(row!) }, 201);
});

router.get("/admin/teams/:id", async ({ req, params }) => {
  await requireTeamAdmin(req, Number(params.id));
  const team = await teamById(Number(params.id));
  const pending = await one<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM bookings WHERE team_id = $1 AND status = 'pending' AND ends_at > NOW()",
    [team.id],
  );
  const admins = await q<{ name: string; email: string }>(
    "SELECT a.name, a.email FROM admins a JOIN team_admins ta ON ta.admin_id = a.id WHERE ta.team_id = $1 ORDER BY a.name",
    [team.id],
  );
  return json({
    team: map.adminTeam({ ...team, pending_count: pending!.n }),
    rooms: await teamRooms(team, false),
    categories: await teamCategories(team.id, false),
    admins,
    people: await activePeopleNames(team.id),
  });
});

router.patch("/admin/teams/:id", async ({ req, params, ip }) => {
  const me = await requireTeamAdmin(req, Number(params.id));
  const existing = await teamById(Number(params.id));
  const b = await body(req);
  const values = { ...(await parseTeam(b, existing)), pin_hash: await pinHashFrom(b.pin, existing.pin_hash) };
  const { cols, params: p } = upsertColumns(values);
  const row = await one<TeamRow>(
    `UPDATE teams SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE id = $${cols.length + 1} RETURNING *`,
    [...p, existing.id],
  );
  const changed = changedFields(existing as unknown as Record<string, unknown>, values, TEAM_LABELS);
  if (changed.length) {
    const pinNote = changed.includes("PIN") ? (values.pin_hash ? " (PIN set)" : " (PIN removed)") : "";
    await logActivity({ teamId: existing.id, action: "team.update", summary: `Changed team settings: ${changed.join(", ")}${pinNote}`, actor: adminActor(me, ip) });
  }
  return json({ team: map.adminTeam(row!) });
});

router.post("/admin/teams/:id/regenerate-link", async ({ req, params, ip }) => {
  const me = await requireTeamAdmin(req, Number(params.id));
  const row = await one<TeamRow>(
    "UPDATE teams SET share_token = $1, feed_token = $2, admin_feed_token = $3 WHERE id = $4 RETURNING *",
    [randomToken(12), randomToken(24), randomToken(32), Number(params.id)],
  );
  if (!row) throw notFound("Team not found.");
  await logActivity({ teamId: row.id, action: "team.link_regenerated", summary: "Regenerated the booking link and calendar feed links", actor: adminActor(me, ip) });
  return json({ team: map.adminTeam(row) });
});

router.delete("/admin/teams/:id", async ({ req, params, ip }) => {
  const me = await requireSuper(req);
  const team = await teamById(Number(params.id));
  await logActivity({ teamId: team.id, action: "team.delete", summary: `Deleted team "${team.name}" with all its rooms and bookings`, actor: adminActor(me, ip) });
  await q("DELETE FROM teams WHERE id = $1", [team.id]);
  return json({ ok: true });
});

// =====================================================================
// Admin: rooms
// =====================================================================

async function parseRoom(b: any, team: TeamRow) {
  const cats = await q<{ id: number }>("SELECT id FROM categories WHERE team_id = $1", [team.id]);
  const valid = new Set(cats.map((c) => c.id));
  const allowed = (Array.isArray(b.allowedCategoryIds) ? b.allowedCategoryIds : []).map(Number).filter((id: number) => valid.has(id));
  const o = parseRuleValues(b.overrides ?? {}, true);
  return {
    name: str(b.name, "Room name", { required: true, max: 120 }),
    code: str(b.code, "Room number", { max: 40 }),
    building: str(b.building, "Building", { max: 120 }),
    campus: str(b.campus, "Campus", { max: 120 }),
    floor: str(b.floor, "Floor", { max: 40 }),
    capacity: int(b.capacity, "Capacity", { min: 1, max: 100000, nullable: true }),
    description: str(b.description, "Description", { max: 4000 }),
    color: color(b.color, "Colour"),
    requires_approval: bool(b.requiresApproval),
    active: b.active === undefined ? true : bool(b.active),
    allowed_category_ids: allowed,
    hours: parseHours(b.hours ?? team.default_hours),
    ...o,
    sort_order: int(b.sortOrder ?? 0, "Sort order", { min: -10000, max: 10000 }),
  };
}

async function roomForAdmin(req: Request, roomId: number) {
  const room = await one<RoomRow>("SELECT * FROM rooms WHERE id = $1", [roomId]);
  if (!room) throw notFound("Room not found.");
  const me = await requireTeamAdmin(req, room.team_id);
  return { room, me };
}

router.post("/admin/teams/:id/rooms", async ({ req, params, ip }) => {
  const me = await requireTeamAdmin(req, Number(params.id));
  const team = await teamById(Number(params.id));
  const parsed = await parseRoom(await body(req), team);
  await ensureLocation(team.id, parsed.campus, parsed.building);
  const { cols, params: p } = upsertColumns({ ...parsed, team_id: team.id });
  const row = await one<RoomRow>(
    `INSERT INTO rooms (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
    p,
  );
  await logActivity({ teamId: team.id, action: "room.create", summary: `Added room ${row!.name}${row!.code ? ` (${row!.code})` : ""}`, actor: adminActor(me, ip) });
  return json({ room: map.room(row!, team) }, 201);
});

router.patch("/admin/rooms/:id", async ({ req, params, ip }) => {
  const { room: existing, me } = await roomForAdmin(req, Number(params.id));
  const team = await teamById(existing.team_id);
  const values = await parseRoom(await body(req), team);
  await ensureLocation(team.id, values.campus, values.building);
  const { cols, params: p } = upsertColumns(values);
  const row = await one<RoomRow>(
    `UPDATE rooms SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE id = $${cols.length + 1} RETURNING *`,
    [...p, existing.id],
  );
  const changed = changedFields(existing as unknown as Record<string, unknown>, values, {
    ...TEAM_LABELS,
    requires_approval: "approval",
    allowed_category_ids: "allowed categories",
    sort_order: "order",
  });
  if (changed.length) {
    await logActivity({ teamId: team.id, action: "room.update", summary: `Changed room ${row!.name}: ${changed.join(", ")}`, actor: adminActor(me, ip) });
  }
  return json({ room: map.room(row!, team) });
});

router.delete("/admin/rooms/:id", async ({ req, params, ip }) => {
  const { room, me } = await roomForAdmin(req, Number(params.id));
  await logActivity({ teamId: room.team_id, action: "room.delete", summary: `Deleted room ${room.name} and its bookings`, actor: adminActor(me, ip) });
  await q("DELETE FROM rooms WHERE id = $1", [room.id]);
  return json({ ok: true });
});

// =====================================================================
// Admin: categories & closures
// =====================================================================

router.post("/admin/teams/:id/categories", async ({ req, params, ip }) => {
  const me = await requireTeamAdmin(req, Number(params.id));
  const team = await teamById(Number(params.id));
  const b = await body(req);
  const row = await one(
    "INSERT INTO categories (team_id, name, color, sort_order, active) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [team.id, str(b.name, "Category name", { required: true, max: 60 }), color(b.color, "Colour"), int(b.sortOrder ?? 0, "Order"), b.active === undefined ? true : bool(b.active)],
  );
  await logActivity({ teamId: team.id, action: "category.create", summary: `Added category "${row.name}"`, actor: adminActor(me, ip) });
  return json({ category: map.category(row) }, 201);
});

async function categoryForAdmin(req: Request, id: number) {
  const cat = await one<{ id: number; team_id: number; name: string; active: boolean }>("SELECT * FROM categories WHERE id = $1", [id]);
  if (!cat) throw notFound("Category not found.");
  return { cat, me: await requireTeamAdmin(req, cat.team_id) };
}

router.patch("/admin/categories/:id", async ({ req, params, ip }) => {
  const { cat, me } = await categoryForAdmin(req, Number(params.id));
  const b = await body(req);
  const row = await one(
    "UPDATE categories SET name = $1, color = $2, sort_order = $3, active = $4 WHERE id = $5 RETURNING *",
    [str(b.name, "Category name", { required: true, max: 60 }), color(b.color, "Colour"), int(b.sortOrder ?? 0, "Order"), bool(b.active), cat.id],
  );
  const what = cat.name !== row.name ? `renamed "${cat.name}" to "${row.name}"` : cat.active !== row.active ? `${row.active ? "reactivated" : "deactivated"} "${row.name}"` : `changed "${row.name}"`;
  await logActivity({ teamId: cat.team_id, action: "category.update", summary: `Category ${what}`, actor: adminActor(me, ip) });
  return json({ category: map.category(row) });
});

router.delete("/admin/categories/:id", async ({ req, params, ip }) => {
  const { cat, me } = await categoryForAdmin(req, Number(params.id));
  await q("DELETE FROM categories WHERE id = $1", [cat.id]);
  await logActivity({ teamId: cat.team_id, action: "category.delete", summary: `Deleted category "${cat.name}"`, actor: adminActor(me, ip) });
  return json({ ok: true });
});

router.get("/admin/teams/:id/closures", async ({ req, params }) => {
  await requireTeamAdmin(req, Number(params.id));
  const rows = await q("SELECT * FROM closures WHERE team_id = $1 ORDER BY start_date DESC", [Number(params.id)]);
  return json({ closures: rows.map(map.closure) });
});

router.post("/admin/teams/:id/closures", async ({ req, params, ip }) => {
  const me = await requireTeamAdmin(req, Number(params.id));
  const team = await teamById(Number(params.id));
  const b = await body(req);
  const start = isoDate(b.startDate, "Start date");
  const end = isoDate(b.endDate || b.startDate, "End date");
  if (end < start) throw bad("The end date is before the start date.");
  let roomId: number | null = null;
  let roomName = "whole team";
  if (b.roomId) {
    const r = await one<{ id: number; name: string }>("SELECT id, name FROM rooms WHERE id = $1 AND team_id = $2", [Number(b.roomId), team.id]);
    if (!r) throw bad("That room isn't in this team.");
    roomId = r.id;
    roomName = r.name;
  }
  const row = await one(
    "INSERT INTO closures (team_id, room_id, start_date, end_date, reason) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [team.id, roomId, start, end, str(b.reason, "Reason", { max: 200 })],
  );
  await logActivity({ teamId: team.id, action: "closure.create", summary: `Added closure ${start}${end !== start ? ` to ${end}` : ""} (${roomName})${row.reason ? `: ${row.reason}` : ""}`, actor: adminActor(me, ip) });
  return json({ closure: map.closure(row) }, 201);
});

router.delete("/admin/closures/:id", async ({ req, params, ip }) => {
  const c = await one("SELECT * FROM closures WHERE id = $1", [Number(params.id)]);
  if (!c) throw notFound("Closure not found.");
  const me = await requireTeamAdmin(req, c.team_id);
  await q("DELETE FROM closures WHERE id = $1", [c.id]);
  const cl = map.closure(c);
  await logActivity({ teamId: c.team_id, action: "closure.delete", summary: `Removed closure ${cl.startDate}${cl.endDate !== cl.startDate ? ` to ${cl.endDate}` : ""}${cl.reason ? `: ${cl.reason}` : ""}`, actor: adminActor(me, ip) });
  return json({ ok: true });
});

// =====================================================================
// Admin: calendar, bookings, approvals, free rooms
// =====================================================================

router.get("/admin/teams/:id/events", async ({ req, params, url }) => {
  await requireTeamAdmin(req, Number(params.id));
  return events(await teamById(Number(params.id)), url, true);
});

router.post("/admin/teams/:id/bookings/preview", async ({ req, params }) => {
  await requireTeamAdmin(req, Number(params.id));
  return json(await preview(await teamById(Number(params.id)), await body(req), true));
});

router.post("/admin/teams/:id/bookings", async ({ req, params, ip }) => {
  const me = await requireTeamAdmin(req, Number(params.id));
  const team = await teamById(Number(params.id));
  const raw = await applyPeopleList(team, await body(req), true);
  return json(await createBooking(team, raw, { admin: true, ip, actor: adminActor(me, ip) }), 201);
});

router.post("/admin/teams/:id/free", async ({ req, params }) => {
  await requireTeamAdmin(req, Number(params.id));
  return json(await findFree(await teamById(Number(params.id)), await body(req), true));
});

router.get("/admin/bookings/:id/token", async ({ req, params }) => {
  const row = await one<{ manage_token: string; team_id: number }>(
    "SELECT s.manage_token, s.team_id FROM bookings b JOIN booking_series s ON s.id = b.series_id WHERE b.id = $1",
    [Number(params.id)],
  );
  if (!row) throw notFound("Booking not found.");
  await requireTeamAdmin(req, row.team_id);
  return json({ manageToken: row.manage_token });
});

router.get("/admin/teams/:id/pending", async ({ req, params }) => {
  await requireTeamAdmin(req, Number(params.id));
  const rows = await q<BookingRow & { room_name: string; category_name: string }>(
    `SELECT b.*, (s.recurrence IS NOT NULL) AS recurring, r.name AS room_name, c.name AS category_name
       FROM bookings b
       JOIN booking_series s ON s.id = b.series_id
       JOIN rooms r ON r.id = b.room_id
       JOIN categories c ON c.id = b.category_id
      WHERE b.team_id = $1 AND b.status = 'pending' AND b.ends_at > NOW()
      ORDER BY b.series_id, b.starts_at`,
    [Number(params.id)],
  );
  return json({
    pending: rows.map((r) => ({ ...map.calendarBooking(r, { admin: true }), roomName: r.room_name, categoryName: r.category_name })),
  });
});

async function decide(ctx: RouteContext, status: "confirmed" | "cancelled") {
  const teamId = Number(ctx.params.id);
  const me = await requireTeamAdmin(ctx.req, teamId);
  const b = await body(ctx.req);
  const ids = (Array.isArray(b.bookingIds) ? b.bookingIds : []).map(Number).filter(Number.isInteger);
  if (!ids.length) throw bad("Choose at least one booking.");
  const rows = await q<{ id: number; title: string; room_id: number; starts_at: Date }>(
    `UPDATE bookings SET status = $1, updated_at = NOW(), cancelled_at = CASE WHEN $1 = 'cancelled' THEN NOW() ELSE NULL END
      WHERE team_id = $2 AND status = 'pending' AND id = ANY($3::int[]) RETURNING id, title, room_id, starts_at`,
    [status, teamId, ids],
  );
  if (rows.length) {
    const team = await teamById(teamId);
    const room = await one<{ name: string }>("SELECT name FROM rooms WHERE id = $1", [rows[0].room_id]);
    const first = DateTime.fromJSDate(rows[0].starts_at).setZone(team.timezone).toFormat("ccc LLL d, yyyy HH:mm");
    await logActivity({
      teamId,
      action: status === "confirmed" ? "booking.approve" : "booking.reject",
      summary: `${status === "confirmed" ? "Approved" : "Declined"} "${rows[0].title}" in ${room?.name ?? "a room"}, ${first}${rows.length > 1 ? ` (+${rows.length - 1} more)` : ""}`,
      details: { bookingIds: rows.map((r) => r.id) },
      actor: adminActor(me, ctx.ip),
    });
  }
  return json({ updated: rows.length });
}

router.post("/admin/teams/:id/approve", (ctx) => decide(ctx, "confirmed"));
router.post("/admin/teams/:id/reject", (ctx) => decide(ctx, "cancelled"));

// =====================================================================
// Members: team share link (no login)
// =====================================================================

async function memberTeam(ctx: RouteContext): Promise<TeamRow> {
  const team = await one<TeamRow>("SELECT * FROM teams WHERE share_token = $1", [ctx.params.token]);
  if (!team) throw notFound("This booking link isn't valid. Ask the team admin for the current link.");
  if (!team.link_access) {
    throw new HttpError(403, `${team.name} now uses staff sign-in. Sign in to book a room.`, {
      loginRequired: true,
      teamName: team.name,
      accentColor: team.accent_color,
      logoDataUrl: team.logo_data_url,
    });
  }
  if (team.pin_hash) {
    const pin = ctx.req.headers.get("x-team-pin") ?? "";
    if (!pin || !safeEqual(await hashPin(pin), team.pin_hash)) {
      if (pin) await rateLimit(`pin:${ctx.ip}:${team.id}`, 20, 900, "Too many wrong PINs. Wait 15 minutes and try again.");
      throw new HttpError(401, pin ? "That PIN is incorrect." : "Enter the team PIN.", {
        pinRequired: true,
        teamName: team.name,
        accentColor: team.accent_color,
        logoDataUrl: team.logo_data_url,
      });
    }
  }
  return team;
}

router.get("/t/:token", async (ctx) => {
  const team = await memberTeam(ctx);
  return json({
    team: map.publicTeam(team),
    rooms: await teamRooms(team, true),
    categories: await teamCategories(team.id, true),
    feedToken: team.feed_token,
    people: await activePeopleNames(team.id),
  });
});

router.get("/t/:token/events", async (ctx) => events(await memberTeam(ctx), ctx.url, false));

router.post("/t/:token/bookings/preview", async (ctx) => {
  const team = await memberTeam(ctx);
  await rateLimit(`preview:${ctx.ip}`, 300, 3600);
  return json(await preview(team, await body(ctx.req), false));
});

router.post("/t/:token/bookings", async (ctx) => {
  const team = await memberTeam(ctx);
  await rateLimit(`book:${ctx.ip}`, 40, 3600, "You've made a lot of bookings in the last hour. Please wait and try again.");
  const b = await applyPeopleList(team, await body(ctx.req), false);
  const name = typeof b.staffName === "string" ? b.staffName.trim().slice(0, 120) : "";
  return json(await createBooking(team, b, { admin: false, ip: ctx.ip, actor: memberActor(name, ctx.ip) }), 201);
});

router.post("/t/:token/free", async (ctx) => {
  const team = await memberTeam(ctx);
  await rateLimit(`free:${ctx.ip}`, 200, 3600);
  return json(await findFree(team, await body(ctx.req), false));
});

// =====================================================================
// Calendar subscription feeds (.ics). No login: the feed token is the key.
// =====================================================================

router.get("/feed/:token", async ({ params, url }) => {
  const token = params.token.replace(/\.ics$/i, "");
  const team = await one<TeamRow>("SELECT * FROM teams WHERE feed_token = $1 OR admin_feed_token = $1", [token]);
  if (!team) return new Response("Feed not found. The link may have been reset.", { status: 404, headers: { "content-type": "text/plain" } });
  const full = team.admin_feed_token === token;
  const roomId = url.searchParams.get("room");
  const params2: unknown[] = [team.id];
  let filter = "";
  if (roomId) {
    params2.push(Number(roomId));
    filter = `AND b.room_id = $2`;
  }
  const rows = await q<BookingRow & { room_name: string; room_code: string; building: string; campus: string; category_name: string }>(
    `SELECT b.*, r.name AS room_name, r.code AS room_code, r.building, r.campus, c.name AS category_name
       FROM bookings b JOIN rooms r ON r.id = b.room_id JOIN categories c ON c.id = b.category_id
      WHERE b.team_id = $1 AND b.status <> 'cancelled'
        AND b.ends_at > NOW() - INTERVAL '60 days' AND b.starts_at < NOW() + INTERVAL '400 days' ${filter}
      ORDER BY b.starts_at LIMIT 5000`,
    params2,
  );
  const room = roomId ? rows[0] ?? (await one("SELECT name AS room_name FROM rooms WHERE id = $1 AND team_id = $2", [Number(roomId), team.id])) : null;
  const host = url.hostname;
  const evs: FeedEvent[] = rows.map((b) => {
    const masked = b.is_private && !full;
    const where = [b.room_name + (b.room_code ? ` (${b.room_code})` : ""), b.building, b.campus].filter(Boolean).join(", ");
    const desc = masked
      ? ""
      : [
          `Booked by: ${b.staff_name}${full && b.staff_email ? ` <${b.staff_email}>` : ""}`,
          `Category: ${b.category_name}`,
          b.attendance ? `Expected attendance: ${b.attendance}` : "",
          b.status === "pending" ? "Status: pending approval" : "",
          b.description,
        ]
          .filter(Boolean)
          .join("\n");
    return {
      uid: `booking-${b.id}@${host}`,
      start: b.starts_at,
      end: b.ends_at,
      summary: `${b.status === "pending" ? "[Pending] " : ""}${masked ? "Busy" : b.title}${roomId ? "" : ` · ${b.room_name}`}`,
      location: where,
      description: desc,
      status: b.status === "pending" ? "TENTATIVE" : "CONFIRMED",
      categories: masked ? undefined : b.category_name,
      updated: b.updated_at ?? b.starts_at,
    };
  });
  const name = `${team.name}${room ? ` · ${room.room_name}` : ""}${full ? " (admin)" : ""}`;
  return new Response(buildCalendar(name, `Room bookings for ${team.name}`, evs), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `inline; filename="${team.name.replace(/[^\w-]+/g, "-").toLowerCase()}.ics"`,
      "cache-control": "public, max-age=300",
    },
  });
});

// =====================================================================
// Manage link (booker edits/cancels without logging in). Admins use the same flow.
// =====================================================================

async function seriesByToken(token: string): Promise<{ series: SeriesRow; team: TeamRow }> {
  const series = await one<SeriesRow>("SELECT * FROM booking_series WHERE manage_token = $1", [token]);
  if (!series) throw notFound("This booking link isn't valid. The booking may have been deleted.");
  return { series, team: await teamById(series.team_id) };
}

async function manageView(token: string, admin: boolean): Promise<ManageView> {
  const { series, team } = await seriesByToken(token);
  return {
    team: map.publicTeam(team),
    rooms: await teamRooms(team, !admin),
    categories: await teamCategories(team.id, !admin),
    recurrence: series.recurrence,
    bookings: (await seriesBookings(series.id)).map(map.managedBooking),
    admin,
    ...(admin ? { teamId: team.id } : {}),
    people: await activePeopleNames(team.id),
  };
}

function manageRoutes(prefix: string, admin: boolean) {
  /** Admins must manage the booking's team; members just need the private link. */
  const access = async (req: Request, token: string, ip: string, nameHint = "") => {
    const ctx = await seriesByToken(token);
    if (admin) {
      const me = await requireTeamAdmin(req, ctx.team.id);
      return { ...ctx, actor: adminActor(me, ip) };
    }
    const owner = await one<{ staff_name: string }>("SELECT staff_name FROM bookings WHERE series_id = $1 ORDER BY id LIMIT 1", [ctx.series.id]);
    return { ...ctx, actor: memberActor(`${nameHint || owner?.staff_name || "Booker"} via private link`, ip) };
  };
  router.get(`${prefix}/:token`, async ({ req, params, ip }) => {
    await access(req, params.token, ip);
    return json(await manageView(params.token, admin));
  });
  router.post(`${prefix}/:token/bookings/:id/preview`, async ({ req, params, ip }) => {
    const { series, team } = await access(req, params.token, ip);
    if (!admin) await rateLimit(`preview:${ip}`, 300, 3600);
    return json(await previewEdit(team, series, Number(params.id), await body(req), admin));
  });
  router.patch(`${prefix}/:token/bookings/:id`, async ({ req, params, ip }) => {
    const raw = await body(req);
    const { series, team, actor } = await access(req, params.token, ip, typeof raw.staffName === "string" ? raw.staffName.trim().slice(0, 120) : "");
    if (!admin) await rateLimit(`edit:${ip}`, 60, 3600);
    const b = await applyPeopleList(team, raw, admin);
    return json(await editSeries(team, series, Number(params.id), b, admin, actor));
  });
  router.post(`${prefix}/:token/bookings/:id/cancel`, async ({ req, params, ip }) => {
    const { series, actor } = await access(req, params.token, ip);
    const b = await body(req);
    return json(await cancelSeries(series, Number(params.id), b.scope, actor));
  });
}
manageRoutes("/manage", false);
manageRoutes("/admin/manage", true);

// =====================================================================
// Invite links, password reset links, and super admin recovery
// =====================================================================

const origin = (req: Request) => new URL(req.url).origin;
const INVITE_HOURS = 7 * 24;
const RESET_HOURS = 24;
const TRANSFER_HOURS = 72;
const TRANSFER_PHRASE = "TRANSFER SUPER ADMIN";
const ACCEPT_PHRASE = "ACCEPT SUPER ADMIN";

function newPassword(v: unknown): string {
  const p = String(v ?? "");
  if (p.length < 10) throw bad("Password must be at least 10 characters.");
  if (p.length > 200) throw bad("Password is too long.");
  return p;
}

const linkView = (t: TokenRow) => ({
  id: t.id,
  kind: t.kind,
  name: t.name,
  email: t.email,
  teamIds: t.team_ids,
  expiresAt: new Date(t.expires_at).toISOString(),
  createdAt: new Date(t.created_at).toISOString(),
});

router.get("/admin/links", async ({ req }) => {
  await requireSuper(req);
  const rows = await q<TokenRow>(
    "SELECT * FROM admin_tokens WHERE kind IN ('invite', 'reset') AND used_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC",
  );
  return json({ links: rows.map(linkView) });
});

router.delete("/admin/links/:id", async ({ req, params, ip }) => {
  const me = await requireSuper(req);
  const row = await one<TokenRow>(
    "UPDATE admin_tokens SET used_at = NOW() WHERE id = $1 AND kind IN ('invite', 'reset') AND used_at IS NULL RETURNING *",
    [Number(params.id)],
  );
  if (row) {
    await logActivity({ teamId: null, action: "admin.link_revoked", summary: `Cancelled the ${row.kind === "invite" ? "invite" : "password reset"} link for ${row.name} (${row.email})`, actor: adminActor(me, ip) });
  }
  return json({ ok: true });
});

router.post("/admin/invites", async ({ req, ip }) => {
  const me = await requireSuper(req);
  const b = await body(req);
  const email = str(b.email, "Email", { required: true, max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad("Email doesn't look right.");
  const name = str(b.name, "Name", { required: true, max: 120 });
  const ids = (Array.isArray(b.teamIds) ? b.teamIds : []).map(Number).filter(Number.isInteger);
  const teams = await q<{ id: number; name: string }>("SELECT id, name FROM teams WHERE id = ANY($1::int[])", [ids]);
  const existing = await one<{ id: number; name: string; is_admin: boolean }>("SELECT id, name, is_admin FROM admins WHERE email = $1", [email]);
  if (existing?.is_admin) throw bad("There's already an admin with that email.");
  if (existing) {
    // They already sign in as staff: make that same account an admin (no new password needed).
    await q("UPDATE admins SET is_admin = TRUE WHERE id = $1", [existing.id]);
    const current = await q<{ team_id: number }>("SELECT team_id FROM team_admins WHERE admin_id = $1", [existing.id]);
    await setAdminTeams(existing.id, [...current.map((c) => c.team_id), ...teams.map((t) => t.id)]);
    await logActivity({ teamId: null, action: "admin.promote", summary: `Made staff account ${existing.name} (${email}) an admin${teams.length ? ` for ${teams.map((t) => t.name).join(", ")}` : ""}`, actor: adminActor(me, ip) });
    return json({ promoted: true, name: existing.name }, 200);
  }
  await revokeOpen("invite", { email });
  const { token, row } = await createToken("invite", { email, name, teamIds: teams.map((t) => t.id), createdBy: me.id }, INVITE_HOURS);
  await logActivity({
    teamId: null,
    action: "admin.invite",
    summary: `Created an invite link for ${name} (${email})${teams.length ? ` for ${teams.map((t) => t.name).join(", ")}` : ""}`,
    actor: adminActor(me, ip),
  });
  return json({ path: `/admin/invite/${token}`, link: `${origin(req)}/admin/invite/${token}`, expiresAt: new Date(row.expires_at).toISOString() }, 201);
});

router.get("/admin/invite/:token", async ({ params, ip }) => {
  await rateLimit(`token:${ip}`, 60, 900);
  const t = await openToken("invite", params.token);
  const teams = await q<{ name: string }>("SELECT name FROM teams WHERE id = ANY($1::int[]) ORDER BY name", [t.team_ids]);
  return json({ name: t.name, email: t.email, teams: teams.map((x) => x.name), expiresAt: new Date(t.expires_at).toISOString() });
});

router.post("/admin/invite/:token", async ({ req, params, ip }) => {
  await rateLimit(`token:${ip}`, 30, 900);
  const b = await body(req);
  const password = newPassword(b.password);
  const name = str(b.name, "Name", { max: 120 });
  const admin = await tx(async (client) => {
    const t = await openToken("invite", params.token, client, true);
    if (await one("SELECT 1 FROM admins WHERE email = $1", [t.email], client)) throw bad("An admin with this email already exists. Sign in instead.");
    const created = (await one<AdminUser>(
      `INSERT INTO admins (email, name, password_hash, last_login_at) VALUES ($1, $2, $3, NOW())
       RETURNING id, email, name, is_super AS "isSuper", is_admin AS "isAdmin"`,
      [t.email, name || t.name, await hashPassword(password)],
      client,
    ))!;
    const teams = await q<{ id: number }>("SELECT id FROM teams WHERE id = ANY($1::int[])", [t.team_ids], client);
    for (const team of teams) {
      await client.query("INSERT INTO team_admins (admin_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [created.id, team.id]);
      await ensurePerson(team.id, created.name, created.email, created.id, client);
    }
    await useToken(t.id, client);
    await logActivity({ teamId: null, action: "admin.invite_accepted", summary: `${created.name} (${created.email}) accepted their invite and set a password`, actor: adminActor(created, ip) }, client);
    return created;
  });
  return json({ admin }, 201, { "set-cookie": await sessionCookie(admin.id, req) });
});

router.post("/admin/admins/:id/reset-link", async ({ req, params, ip }) => {
  const me = await requireSuper(req);
  const target = await one<{ id: number; name: string; email: string }>("SELECT id, name, email FROM admins WHERE id = $1 AND is_admin", [Number(params.id)]);
  if (!target) throw notFound("Admin not found.");
  if (target.id === me.id) throw bad("Change your own password under Admin accounts instead.");
  await revokeOpen("reset", { adminId: target.id });
  const { token, row } = await createToken("reset", { adminId: target.id, email: target.email, name: target.name, createdBy: me.id }, RESET_HOURS);
  await logActivity({ teamId: null, action: "admin.reset_link", summary: `Created a password reset link for ${target.name} (${target.email})`, actor: adminActor(me, ip) });
  return json({ path: `/admin/reset/${token}`, link: `${origin(req)}/admin/reset/${token}`, expiresAt: new Date(row.expires_at).toISOString() }, 201);
});

router.get("/admin/reset/:token", async ({ params, ip }) => {
  await rateLimit(`token:${ip}`, 60, 900);
  const t = await openToken("reset", params.token);
  return json({ name: t.name, email: t.email, expiresAt: new Date(t.expires_at).toISOString() });
});

router.post("/admin/reset/:token", async ({ req, params, ip }) => {
  await rateLimit(`token:${ip}`, 30, 900);
  const b = await body(req);
  const password = newPassword(b.password);
  const admin = await tx(async (client) => {
    const t = await openToken("reset", params.token, client, true);
    const a = await one<AdminUser>(
      `UPDATE admins SET password_hash = $1, session_version = session_version + 1, last_login_at = NOW() WHERE id = $2
       RETURNING id, email, name, is_super AS "isSuper", is_admin AS "isAdmin"`,
      [await hashPassword(password), t.admin_id],
      client,
    );
    if (!a) throw notFound("That admin account no longer exists.");
    await useToken(t.id, client);
    await logActivity({ teamId: null, action: "admin.password_reset", summary: `${a.name} reset their password with a reset link (other sessions signed out)`, actor: adminActor(a, ip) }, client);
    return a;
  });
  return json({ admin }, 200, { "set-cookie": await sessionCookie(admin.id, req) });
});

/** If the super admin forgets their password: prove it's you with ADMIN_SETUP_KEY. */
router.post("/admin/recover", async ({ req, ip }) => {
  await rateLimit(`recover:${ip}`, 5, 3600, "Too many recovery attempts. Wait an hour and try again.");
  const b = await body(req);
  const key = process.env.ADMIN_SETUP_KEY;
  if (!key) throw bad("Recovery needs the ADMIN_SETUP_KEY environment variable. Add it in Netlify, redeploy, then try again.");
  const email = String(b.email ?? "").trim().toLowerCase();
  const superAdmin = await one<{ id: number; email: string; name: string }>("SELECT id, email, name FROM admins WHERE is_super");
  const keyOk = safeEqual(String(b.setupKey ?? ""), key);
  if (!keyOk || !superAdmin || superAdmin.email !== email) {
    await logActivity({ teamId: null, action: "admin.recover_failed", summary: `Failed super admin recovery attempt for ${email.slice(0, 120) || "(blank)"}`, actor: { type: "system", name: email.slice(0, 120), ip } });
    throw new HttpError(403, "The setup key or email is wrong. Only the super admin's account can be recovered this way.");
  }
  const password = newPassword(b.newPassword);
  await q("UPDATE admins SET password_hash = $1, session_version = session_version + 1, last_login_at = NOW() WHERE id = $2", [await hashPassword(password), superAdmin.id]);
  const admin = { ...superAdmin, isSuper: true, isAdmin: true };
  await logActivity({ teamId: null, action: "admin.recovered", summary: `Super admin password reset with the setup key (other sessions signed out)`, actor: adminActor(admin, ip) });
  return json({ admin }, 200, { "set-cookie": await sessionCookie(superAdmin.id, req) });
});

// =====================================================================
// Super admin handover (two-party: offered by the super admin, accepted by the other admin)
// =====================================================================

async function openTransfer(client = undefined as any): Promise<(TokenRow & { from_name: string; to_name: string; to_email: string }) | null> {
  return one(
    `SELECT t.*, f.name AS from_name, a.name AS to_name, a.email AS to_email
       FROM admin_tokens t JOIN admins f ON f.id = t.created_by JOIN admins a ON a.id = t.admin_id
      WHERE t.kind = 'transfer' AND t.used_at IS NULL AND t.expires_at > NOW()`,
    [],
    client,
  );
}

async function transferFor(admin: AdminUser) {
  const t = await openTransfer();
  if (!t) return null;
  const view = {
    id: t.id,
    fromName: t.from_name,
    toName: t.to_name,
    toEmail: t.to_email,
    keepTeamIds: t.team_ids,
    expiresAt: new Date(t.expires_at).toISOString(),
  };
  if (admin.isSuper && t.created_by === admin.id) return { direction: "out" as const, ...view };
  if (t.admin_id === admin.id) return { direction: "in" as const, ...view };
  return null;
}

router.post("/admin/super-transfer", async ({ req, ip }) => {
  const me = await requireSuper(req);
  await rateLimit(`transfer:${me.id}`, 10, 3600);
  const b = await body(req);
  const pw = await one<{ password_hash: string }>("SELECT password_hash FROM admins WHERE id = $1", [me.id]);
  if (!(await verifyPassword(String(b.password ?? ""), pw!.password_hash))) throw bad("Your password is incorrect.");
  if (String(b.phrase ?? "").trim() !== TRANSFER_PHRASE) throw bad(`Type ${TRANSFER_PHRASE} exactly to confirm.`);
  const target = await one<{ id: number; name: string; email: string; is_super: boolean; last_login_at: Date | null }>(
    "SELECT id, name, email, is_super, last_login_at FROM admins WHERE id = $1 AND is_admin",
    [Number(b.targetId)],
  );
  if (!target || target.id === me.id || target.is_super) throw bad("Choose another admin to hand the super admin role to.");
  if (!target.last_login_at) throw bad(`${target.name} has never signed in. They need to sign in at least once before they can take over.`);
  if (String(b.confirmEmail ?? "").trim().toLowerCase() !== target.email) throw bad(`Type ${target.name}'s email address exactly to confirm.`);
  if (b.understood !== true) throw bad("Confirm that you understand what you'll lose.");
  if (await openTransfer()) throw bad("There's already a handover waiting. Cancel it first.");
  const ids = (Array.isArray(b.keepTeamIds) ? b.keepTeamIds : []).map(Number).filter(Number.isInteger);
  const keep = await q<{ id: number; name: string }>("SELECT id, name FROM teams WHERE id = ANY($1::int[]) ORDER BY name", [ids]);
  await createToken("transfer", { adminId: target.id, email: target.email, name: target.name, teamIds: keep.map((t) => t.id), createdBy: me.id }, TRANSFER_HOURS);
  await logActivity({
    teamId: null,
    action: "admin.transfer_offered",
    summary: `Offered the super admin role to ${target.name} (${target.email}). If accepted, ${me.name} stays admin of: ${keep.map((t) => t.name).join(", ") || "no teams"}`,
    actor: adminActor(me, ip),
  });
  return json({ transfer: await transferFor(me) }, 201);
});

router.delete("/admin/super-transfer", async ({ req, ip }) => {
  const me = await requireAdmin(req);
  const t = await openTransfer();
  if (!t || (t.created_by !== me.id && t.admin_id !== me.id)) throw notFound("There's no handover waiting.");
  await useToken(t.id);
  const declined = t.admin_id === me.id;
  await logActivity({
    teamId: null,
    action: declined ? "admin.transfer_declined" : "admin.transfer_cancelled",
    summary: declined ? `${me.name} declined the super admin role` : `${me.name} cancelled the super admin handover to ${t.to_name}`,
    actor: adminActor(me, ip),
  });
  return json({ ok: true });
});

router.post("/admin/super-transfer/accept", async ({ req, ip }) => {
  const me = await requireAdmin(req);
  const b = await body(req);
  const pw = await one<{ password_hash: string }>("SELECT password_hash FROM admins WHERE id = $1", [me.id]);
  if (!(await verifyPassword(String(b.password ?? ""), pw!.password_hash))) throw bad("Your password is incorrect.");
  if (String(b.phrase ?? "").trim() !== ACCEPT_PHRASE) throw bad(`Type ${ACCEPT_PHRASE} exactly to confirm.`);
  const result = await tx(async (client) => {
    const t = await one<TokenRow>(
      "SELECT * FROM admin_tokens WHERE kind = 'transfer' AND used_at IS NULL AND expires_at > NOW() AND admin_id = $1 FOR UPDATE",
      [me.id],
      client,
    );
    if (!t) throw notFound("There's no handover waiting for you, or it has expired.");
    const from = await one<{ id: number; name: string; email: string; is_super: boolean }>(
      "SELECT id, name, email, is_super FROM admins WHERE id = $1 FOR UPDATE",
      [t.created_by],
      client,
    );
    if (!from?.is_super) throw bad("The person who offered this is no longer the super admin.");
    // Order matters: the database allows only one super admin at a time.
    await client.query("UPDATE admins SET is_super = FALSE WHERE id = $1", [from.id]);
    await client.query("UPDATE admins SET is_super = TRUE WHERE id = $1", [me.id]);
    await client.query("DELETE FROM team_admins WHERE admin_id = $1", [me.id]); // super admin sees every team anyway
    const keep = await q<{ id: number; name: string }>("SELECT id, name FROM teams WHERE id = ANY($1::int[])", [t.team_ids], client);
    for (const team of keep) {
      await client.query("INSERT INTO team_admins (admin_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [from.id, team.id]);
      await ensurePerson(team.id, from.name, from.email, from.id, client);
    }
    await useToken(t.id, client);
    await logActivity(
      {
        teamId: null,
        action: "admin.transfer_completed",
        summary: `${me.name} is now the super admin (handed over by ${from.name}, who keeps: ${keep.map((k) => k.name).join(", ") || "no teams"})`,
        actor: adminActor(me, ip),
      },
      client,
    );
    return { fromName: from.name };
  });
  return json({ ok: true, ...result });
});

// =====================================================================
// People (staff list per team, used for the name dropdown when booking)
// =====================================================================

const personView = (p: PersonRow & { account_is_admin?: boolean | null; invite_pending?: boolean }) => ({
  id: p.id,
  name: p.name,
  email: p.email,
  role: p.role,
  active: p.active,
  isAdmin: !!p.account_is_admin,
  hasLogin: !!p.admin_id,
  invitePending: !!p.invite_pending,
});

const PEOPLE_SELECT = `SELECT p.*, a.is_admin AS account_is_admin,
    EXISTS (SELECT 1 FROM admin_tokens t WHERE t.kind = 'staff_invite' AND t.person_id = p.id AND t.used_at IS NULL AND t.expires_at > NOW()) AS invite_pending
  FROM people p LEFT JOIN admins a ON a.id = p.admin_id`;

function parsePerson(b: any) {
  const email = str(b.email, "Email", { max: 200 }).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad("Email doesn't look right.");
  return {
    name: str(b.name, "Name", { required: true, max: 120 }),
    email,
    role: str(b.role, "Role", { max: 120 }),
    active: b.active === undefined ? true : bool(b.active),
  };
}

router.get("/admin/teams/:id/people", async ({ req, params }) => {
  await requireTeamAdmin(req, Number(params.id));
  const rows = await q<PersonRow>(`${PEOPLE_SELECT} WHERE p.team_id = $1 ORDER BY p.active DESC, lower(p.name)`, [Number(params.id)]);
  return json({ people: rows.map(personView) });
});

router.post("/admin/teams/:id/people", async ({ req, params, ip }) => {
  const teamId = Number(params.id);
  const me = await requireTeamAdmin(req, teamId);
  const p = parsePerson(await body(req));
  const row = await one<PersonRow>(
    "INSERT INTO people (team_id, name, email, role, active) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [teamId, p.name, p.email, p.role, p.active],
  );
  await logActivity({ teamId, action: "people.create", summary: `Added ${p.name} to the people list`, actor: adminActor(me, ip) });
  return json({ person: personView(row!) }, 201);
});

async function personForAdmin(req: Request, id: number) {
  const person = await one<PersonRow>("SELECT * FROM people WHERE id = $1", [id]);
  if (!person) throw notFound("Person not found.");
  return { person, me: await requireTeamAdmin(req, person.team_id) };
}

router.patch("/admin/people/:id", async ({ req, params, ip }) => {
  const { person, me } = await personForAdmin(req, Number(params.id));
  const p = parsePerson(await body(req));
  const row = await one<PersonRow>(
    "UPDATE people SET name = $1, email = $2, role = $3, active = $4 WHERE id = $5 RETURNING *",
    [p.name, p.email, p.role, p.active, person.id],
  );
  const what =
    person.active !== p.active ? (p.active ? "Reactivated" : "Deactivated") : person.name !== p.name ? `Renamed ${person.name} to` : "Updated";
  await logActivity({ teamId: person.team_id, action: "people.update", summary: `${what} ${p.name}`, actor: adminActor(me, ip) });
  return json({ person: personView(row!) });
});

router.delete("/admin/people/:id", async ({ req, params, ip }) => {
  const { person, me } = await personForAdmin(req, Number(params.id));
  await q("DELETE FROM people WHERE id = $1", [person.id]);
  if (person.admin_id) await removeOrphanStaffAccount(person.admin_id);
  await logActivity({ teamId: person.team_id, action: "people.delete", summary: `Removed ${person.name} from the people list (their bookings are unchanged)`, actor: adminActor(me, ip) });
  return json({ ok: true });
});

/** Paste a list: one person per line, "Name, email, role" (email and role optional; tabs work too). */
router.post("/admin/teams/:id/people/import", async ({ req, params, ip }) => {
  const teamId = Number(params.id);
  const me = await requireTeamAdmin(req, teamId);
  const b = await body(req);
  const text = String(b.text ?? "");
  if (text.length > 100_000) throw bad("That list is too long. Import at most a few thousand people at a time.");
  let added = 0;
  const skipped: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(/\t|,/).map((x) => x.trim());
    if (!parts[0]) continue;
    const [name, email = "", role = ""] = parts;
    if (name.toLowerCase() === "name" && (email.toLowerCase() === "email" || !email)) continue; // header row
    if (name.length > 120 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      skipped.push(line.slice(0, 80));
      continue;
    }
    const res = await q(
      `INSERT INTO people (team_id, name, email, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
      [teamId, name, email.toLowerCase(), role.slice(0, 120)],
    );
    if (res.length) added++;
    else skipped.push(`${name} (already on the list)`);
  }
  if (added) await logActivity({ teamId, action: "people.import", summary: `Imported ${added} ${added === 1 ? "person" : "people"} to the people list`, actor: adminActor(me, ip) });
  return json({ added, skipped });
});

// =====================================================================
// Staff sign-in: give people on a team's list their own login
// =====================================================================

/** A staff account with no team left is deleted (admins are never removed this way). */
async function removeOrphanStaffAccount(accountId: number) {
  await q(
    `DELETE FROM admins WHERE id = $1 AND NOT is_admin AND NOT EXISTS (SELECT 1 FROM people WHERE admin_id = $1)`,
    [accountId],
  );
}

router.post("/admin/people/:id/access", async ({ req, params, ip }) => {
  const { person, me } = await personForAdmin(req, Number(params.id));
  if (person.admin_id) throw bad(`${person.name} can already sign in.`);
  if (!person.email) throw bad(`Add an email for ${person.name} first. It's what they sign in with.`);
  const existing = await one<{ id: number; name: string }>("SELECT id, name FROM admins WHERE email = $1", [person.email.toLowerCase()]);
  if (existing) {
    // Same person already has an account (another team, or an admin): just connect it.
    await q("UPDATE people SET admin_id = $1 WHERE id = $2", [existing.id, person.id]);
    await logActivity({ teamId: person.team_id, action: "people.access", summary: `${person.name} can now sign in with their existing account`, actor: adminActor(me, ip) });
    return json({ linked: true });
  }
  await q("UPDATE admin_tokens SET used_at = NOW() WHERE kind = 'staff_invite' AND person_id = $1 AND used_at IS NULL", [person.id]);
  const { token, row } = await createToken(
    "staff_invite",
    { email: person.email.toLowerCase(), name: person.name, teamIds: [person.team_id], createdBy: me.id, personId: person.id },
    INVITE_HOURS,
  );
  await logActivity({ teamId: person.team_id, action: "people.invite", summary: `Created a sign-in invite link for ${person.name} (${person.email})`, actor: adminActor(me, ip) });
  return json({ path: `/invite/${token}`, expiresAt: new Date(row.expires_at).toISOString() }, 201);
});

router.delete("/admin/people/:id/access", async ({ req, params, ip }) => {
  const { person, me } = await personForAdmin(req, Number(params.id));
  await q("UPDATE admin_tokens SET used_at = NOW() WHERE kind = 'staff_invite' AND person_id = $1 AND used_at IS NULL", [person.id]);
  if (person.admin_id) {
    const acct = await one<{ is_admin: boolean }>("SELECT is_admin FROM admins WHERE id = $1", [person.admin_id]);
    if (acct?.is_admin) throw bad(`${person.name} is an admin. Manage their access under Admin accounts instead.`);
    await q("UPDATE people SET admin_id = NULL WHERE id = $1", [person.id]);
    await removeOrphanStaffAccount(person.admin_id);
  }
  await logActivity({ teamId: person.team_id, action: "people.access_removed", summary: `Removed ${person.name}'s sign-in for this team`, actor: adminActor(me, ip) });
  return json({ ok: true });
});

router.post("/admin/people/:id/reset-link", async ({ req, params, ip }) => {
  const { person, me } = await personForAdmin(req, Number(params.id));
  if (!person.admin_id) throw bad(`${person.name} doesn't have a sign-in yet.`);
  const acct = await one<{ id: number; name: string; email: string; is_admin: boolean }>("SELECT id, name, email, is_admin FROM admins WHERE id = $1", [person.admin_id]);
  if (!acct) throw notFound("Account not found.");
  if (acct.is_admin && !me.isSuper) throw bad(`${acct.name} is an admin. Only the super admin can reset an admin's password.`);
  if (acct.id === me.id) throw bad("Change your own password under My account instead.");
  await revokeOpen("reset", { adminId: acct.id });
  const { token, row } = await createToken("reset", { adminId: acct.id, email: acct.email, name: acct.name, createdBy: me.id }, RESET_HOURS);
  await logActivity({ teamId: person.team_id, action: "people.reset_link", summary: `Created a password reset link for ${acct.name}`, actor: adminActor(me, ip) });
  return json({ path: `/reset/${token}`, expiresAt: new Date(row.expires_at).toISOString() }, 201);
});

router.get("/invite/:token", async ({ params, ip }) => {
  await rateLimit(`token:${ip}`, 60, 900);
  const t = await openToken("staff_invite", params.token);
  const team = await one<{ name: string; accent_color: string; logo_data_url: string | null }>("SELECT name, accent_color, logo_data_url FROM teams WHERE id = $1", [t.team_ids[0]]);
  return json({ name: t.name, email: t.email, teamName: team?.name ?? "", accentColor: team?.accent_color, logoDataUrl: team?.logo_data_url ?? null, expiresAt: new Date(t.expires_at).toISOString() });
});

router.post("/invite/:token", async ({ req, params, ip }) => {
  await rateLimit(`token:${ip}`, 30, 900);
  const b = await body(req);
  const password = newPassword(b.password);
  const account = await tx(async (client) => {
    const t = await openToken("staff_invite", params.token, client, true);
    const person = t.person_id ? await one<PersonRow>("SELECT * FROM people WHERE id = $1 FOR UPDATE", [t.person_id], client) : null;
    if (!person) throw new HttpError(410, "This person has been removed from the team's list.");
    if (await one("SELECT 1 FROM admins WHERE email = $1", [t.email], client)) throw bad("An account with this email already exists. Sign in instead.");
    const created = (await one<AdminUser>(
      `INSERT INTO admins (email, name, password_hash, is_admin, last_login_at) VALUES ($1, $2, $3, FALSE, NOW())
       RETURNING id, email, name, is_super AS "isSuper", is_admin AS "isAdmin"`,
      [t.email, person.name, await hashPassword(password)],
      client,
    ))!;
    await client.query("UPDATE people SET admin_id = $1 WHERE id = $2", [created.id, person.id]);
    await useToken(t.id, client);
    await logActivity({ teamId: person.team_id, action: "people.joined", summary: `${created.name} set a password and can now sign in`, actor: adminActor(created, ip) }, client);
    return created;
  });
  return json({ account }, 201, { "set-cookie": await sessionCookie(account.id, req) });
});

// =====================================================================
// Signed-in dashboard (staff and admins)
// =====================================================================

async function myTeams(a: AdminUser) {
  const rows = await q<TeamRow & { role: string }>(
    `SELECT t.*, CASE WHEN $2 OR EXISTS (SELECT 1 FROM team_admins ta WHERE ta.team_id = t.id AND ta.admin_id = $1) THEN 'admin' ELSE 'staff' END AS role
       FROM teams t
      WHERE ($2)
         OR EXISTS (SELECT 1 FROM team_admins ta WHERE ta.team_id = t.id AND ta.admin_id = $1 AND $3)
         OR EXISTS (SELECT 1 FROM people p WHERE p.team_id = t.id AND p.admin_id = $1 AND p.active)
      ORDER BY t.name`,
    [a.id, a.isSuper, a.isAdmin],
  );
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    accentColor: t.accent_color,
    logoDataUrl: t.logo_data_url,
    timezone: t.timezone,
    role: t.role as "admin" | "staff",
  }));
}

router.get("/me", async ({ req }) => {
  const account = await requireAccount(req);
  return json({ account, teams: await myTeams(account), transfer: account.isAdmin ? await transferFor(account) : null });
});

router.get("/me/bookings", async ({ req }) => {
  const a = await requireAccount(req);
  const teamIds = (await myTeams(a)).map((t) => t.id);
  const rows = await q(
    `SELECT b.*, s.manage_token, (s.recurrence IS NOT NULL) AS recurring, r.name AS room_name, t.name AS team_name, c.name AS category_name
       FROM bookings b
       JOIN booking_series s ON s.id = b.series_id
       JOIN rooms r ON r.id = b.room_id
       JOIN teams t ON t.id = b.team_id
       JOIN categories c ON c.id = b.category_id
      WHERE b.team_id = ANY($2::int[]) AND b.status <> 'cancelled' AND b.ends_at > NOW()
        AND (s.account_id = $1 OR lower(b.staff_email) = lower($3))
      ORDER BY b.starts_at LIMIT 60`,
    [a.id, teamIds, a.email],
  );
  return json({
    bookings: rows.map((b) => ({
      id: b.id,
      seriesId: b.series_id,
      teamId: b.team_id,
      teamName: b.team_name,
      roomName: b.room_name,
      title: b.title,
      categoryName: b.category_name,
      startsAt: new Date(b.starts_at).toISOString(),
      endsAt: new Date(b.ends_at).toISOString(),
      allDay: b.all_day,
      status: b.status,
      recurring: b.recurring,
      manageToken: b.manage_token,
    })),
  });
});

/** Signed-in staff access to a team: they must be on its People list (or manage it). */
async function staffTeam(req: Request, teamId: number) {
  const account = await requireAccount(req);
  const team = await teamById(teamId);
  const person = await one<PersonRow>("SELECT * FROM people WHERE team_id = $1 AND admin_id = $2 AND active", [team.id, account.id]);
  const isTeamAdmin = account.isAdmin && (account.isSuper || !!(await one("SELECT 1 FROM team_admins WHERE team_id = $1 AND admin_id = $2", [team.id, account.id])));
  if (!person && !isTeamAdmin) throw new HttpError(403, "You're not on this team's People list. Ask a team admin to add you.");
  return { account, team, person };
}

/** Staff book as themselves: name and email come from their People entry / account. */
function asSelf(raw: any, account: AdminUser, person: PersonRow | null) {
  return { ...raw, staffName: person?.name ?? account.name, staffEmail: person?.email || account.email };
}

router.get("/s/teams/:id", async ({ req, params }) => {
  const { account, team, person } = await staffTeam(req, Number(params.id));
  return json({
    team: map.publicTeam(team),
    rooms: await teamRooms(team, true),
    categories: await teamCategories(team.id, true),
    feedToken: team.feed_token,
    people: [],
    me: { name: person?.name ?? account.name, email: person?.email || account.email },
  });
});

router.get("/s/teams/:id/events", async ({ req, params, url }) => {
  const { team } = await staffTeam(req, Number(params.id));
  return events(team, url, false);
});

router.post("/s/teams/:id/bookings/preview", async ({ req, params, ip }) => {
  const { account, team, person } = await staffTeam(req, Number(params.id));
  await rateLimit(`preview:${ip}`, 300, 3600);
  return json(await preview(team, asSelf(await body(req), account, person), false));
});

router.post("/s/teams/:id/bookings", async ({ req, params, ip }) => {
  const { account, team, person } = await staffTeam(req, Number(params.id));
  await rateLimit(`book:${account.id}`, 60, 3600, "You've made a lot of bookings in the last hour. Please wait and try again.");
  const raw = asSelf(await body(req), account, person);
  return json(await createBooking(team, raw, { admin: false, ip, actor: memberActor(raw.staffName, ip), accountId: account.id }), 201);
});

router.post("/s/teams/:id/free", async ({ req, params, ip }) => {
  const { team } = await staffTeam(req, Number(params.id));
  await rateLimit(`free:${ip}`, 200, 3600);
  return json(await findFree(team, await body(req), false));
});

// =====================================================================
// Locations: campus and building lists (per team), and ordering
// =====================================================================

interface CampusRow { id: number; team_id: number; name: string; sort_order: number }
interface BuildingRow { id: number; team_id: number; campus_id: number | null; name: string; code: string; sort_order: number }

async function locations(teamId: number) {
  const campuses = await q<CampusRow & { room_count: number }>(
    `SELECT c.*, (SELECT COUNT(*)::int FROM rooms r WHERE r.team_id = c.team_id AND lower(r.campus) = lower(c.name)) AS room_count
       FROM campuses c WHERE c.team_id = $1 ORDER BY c.sort_order, lower(c.name)`,
    [teamId],
  );
  const buildings = await q<BuildingRow & { room_count: number }>(
    `SELECT b.*, (SELECT COUNT(*)::int FROM rooms r WHERE r.team_id = b.team_id AND lower(r.building) = lower(b.name)) AS room_count
       FROM buildings b WHERE b.team_id = $1 ORDER BY b.sort_order, lower(b.name)`,
    [teamId],
  );
  return {
    campuses: campuses.map((c) => ({ id: c.id, name: c.name, roomCount: c.room_count })),
    buildings: buildings.map((b) => ({ id: b.id, name: b.name, code: b.code, campusId: b.campus_id, roomCount: b.room_count })),
  };
}

/** Keeps the lists in step with rooms: a campus/building typed on a room is added to the list. */
async function ensureLocation(teamId: number, campus: string, building: string) {
  let campusId: number | null = null;
  if (campus) {
    await q("INSERT INTO campuses (team_id, name, sort_order) VALUES ($1, $2, 1000) ON CONFLICT DO NOTHING", [teamId, campus]);
    campusId = (await one<{ id: number }>("SELECT id FROM campuses WHERE team_id = $1 AND lower(name) = lower($2)", [teamId, campus]))?.id ?? null;
  }
  if (building) {
    await q("INSERT INTO buildings (team_id, name, campus_id, sort_order) VALUES ($1, $2, $3, 1000) ON CONFLICT DO NOTHING", [teamId, building, campusId]);
  }
}

router.get("/admin/teams/:id/locations", async ({ req, params }) => {
  await requireTeamAdmin(req, Number(params.id));
  return json(await locations(Number(params.id)));
});

router.post("/admin/teams/:id/campuses", async ({ req, params, ip }) => {
  const teamId = Number(params.id);
  const me = await requireTeamAdmin(req, teamId);
  const name = str((await body(req)).name, "Campus name", { required: true, max: 120 });
  const n = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM campuses WHERE team_id = $1", [teamId]);
  await q("INSERT INTO campuses (team_id, name, sort_order) VALUES ($1, $2, $3)", [teamId, name, n!.n]);
  await logActivity({ teamId, action: "location.create", summary: `Added campus ${name}`, actor: adminActor(me, ip) });
  return json(await locations(teamId), 201);
});

router.post("/admin/teams/:id/buildings", async ({ req, params, ip }) => {
  const teamId = Number(params.id);
  const me = await requireTeamAdmin(req, teamId);
  const b = await body(req);
  const name = str(b.name, "Building name", { required: true, max: 120 });
  const code = str(b.code, "Building code", { max: 20 });
  const campusId = b.campusId ? Number(b.campusId) : null;
  if (campusId && !(await one("SELECT 1 FROM campuses WHERE id = $1 AND team_id = $2", [campusId, teamId]))) throw bad("That campus isn't in this team.");
  const n = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM buildings WHERE team_id = $1", [teamId]);
  await q("INSERT INTO buildings (team_id, name, code, campus_id, sort_order) VALUES ($1, $2, $3, $4, $5)", [teamId, name, code, campusId, n!.n]);
  await logActivity({ teamId, action: "location.create", summary: `Added building ${name}`, actor: adminActor(me, ip) });
  return json(await locations(teamId), 201);
});

router.patch("/admin/campuses/:id", async ({ req, params, ip }) => {
  const c = await one<CampusRow>("SELECT * FROM campuses WHERE id = $1", [Number(params.id)]);
  if (!c) throw notFound("Campus not found.");
  const me = await requireTeamAdmin(req, c.team_id);
  const name = str((await body(req)).name, "Campus name", { required: true, max: 120 });
  await tx(async (client) => {
    await client.query("UPDATE campuses SET name = $1 WHERE id = $2", [name, c.id]);
    await client.query("UPDATE rooms SET campus = $1 WHERE team_id = $2 AND lower(campus) = lower($3)", [name, c.team_id, c.name]);
  });
  if (name !== c.name) await logActivity({ teamId: c.team_id, action: "location.update", summary: `Renamed campus ${c.name} to ${name} (rooms updated)`, actor: adminActor(me, ip) });
  return json(await locations(c.team_id));
});

router.patch("/admin/buildings/:id", async ({ req, params, ip }) => {
  const bld = await one<BuildingRow>("SELECT * FROM buildings WHERE id = $1", [Number(params.id)]);
  if (!bld) throw notFound("Building not found.");
  const me = await requireTeamAdmin(req, bld.team_id);
  const b = await body(req);
  const name = str(b.name, "Building name", { required: true, max: 120 });
  const code = str(b.code, "Building code", { max: 20 });
  const campusId = b.campusId ? Number(b.campusId) : null;
  const campus = campusId ? await one<CampusRow>("SELECT * FROM campuses WHERE id = $1 AND team_id = $2", [campusId, bld.team_id]) : null;
  if (campusId && !campus) throw bad("That campus isn't in this team.");
  await tx(async (client) => {
    await client.query("UPDATE buildings SET name = $1, code = $2, campus_id = $3 WHERE id = $4", [name, code, campusId, bld.id]);
    // Rooms in this building follow its new name and campus.
    await client.query("UPDATE rooms SET building = $1, campus = COALESCE($2, campus) WHERE team_id = $3 AND lower(building) = lower($4)", [
      name,
      campus?.name ?? null,
      bld.team_id,
      bld.name,
    ]);
  });
  await logActivity({ teamId: bld.team_id, action: "location.update", summary: `Changed building ${bld.name}${name !== bld.name ? ` → ${name}` : ""}${campus ? ` (${campus.name})` : ""}`, actor: adminActor(me, ip) });
  return json(await locations(bld.team_id));
});

router.delete("/admin/campuses/:id", async ({ req, params, ip }) => {
  const c = await one<CampusRow>("SELECT * FROM campuses WHERE id = $1", [Number(params.id)]);
  if (!c) throw notFound("Campus not found.");
  const me = await requireTeamAdmin(req, c.team_id);
  const used = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM rooms WHERE team_id = $1 AND lower(campus) = lower($2)", [c.team_id, c.name]);
  if (used!.n) throw bad(`${used!.n} room${used!.n === 1 ? " is" : "s are"} on this campus. Move ${used!.n === 1 ? "it" : "them"} first.`);
  await q("DELETE FROM campuses WHERE id = $1", [c.id]);
  await logActivity({ teamId: c.team_id, action: "location.delete", summary: `Removed campus ${c.name}`, actor: adminActor(me, ip) });
  return json(await locations(c.team_id));
});

router.delete("/admin/buildings/:id", async ({ req, params, ip }) => {
  const bld = await one<BuildingRow>("SELECT * FROM buildings WHERE id = $1", [Number(params.id)]);
  if (!bld) throw notFound("Building not found.");
  const me = await requireTeamAdmin(req, bld.team_id);
  const used = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM rooms WHERE team_id = $1 AND lower(building) = lower($2)", [bld.team_id, bld.name]);
  if (used!.n) throw bad(`${used!.n} room${used!.n === 1 ? " is" : "s are"} in this building. Move ${used!.n === 1 ? "it" : "them"} first.`);
  await q("DELETE FROM buildings WHERE id = $1", [bld.id]);
  await logActivity({ teamId: bld.team_id, action: "location.delete", summary: `Removed building ${bld.name}`, actor: adminActor(me, ip) });
  return json(await locations(bld.team_id));
});

/** Saves a drag-and-drop order. kind = categories | campuses | buildings. */
router.post("/admin/teams/:id/order/:kind", async ({ req, params, ip }) => {
  const teamId = Number(params.id);
  const me = await requireTeamAdmin(req, teamId);
  const table = ({ categories: "categories", campuses: "campuses", buildings: "buildings" } as Record<string, string>)[params.kind];
  if (!table) throw notFound();
  const ids = ((await body(req)).ids ?? []).map(Number).filter(Number.isInteger);
  await tx(async (client) => {
    for (const [i, id] of ids.entries()) {
      await client.query(`UPDATE ${table} SET sort_order = $1 WHERE id = $2 AND team_id = $3`, [i, id, teamId]);
    }
  });
  await logActivity({ teamId, action: `${params.kind === "categories" ? "category" : "location"}.reorder`, summary: `Reordered ${params.kind}`, actor: adminActor(me, ip) });
  return json({ ok: true });
});
