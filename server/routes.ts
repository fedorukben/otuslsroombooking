import { DateTime, IANAZone } from "luxon";
import type { ManageView, WeeklyHours } from "../shared/types.js";
import type { ActivityEntry, AdminAccount } from "../shared/types.js";
import { adminActor, logActivity, memberActor } from "./activity.js";
import { type AdminUser, clearCookie, currentAdmin, hashPin, requireAdmin, requireSuper, requireTeamAdmin, sessionCookie } from "./auth.js";
import { cancelSeries, createBooking, editSeries, findFree, preview, previewEdit, seriesBookings, type SeriesRow } from "./bookings.js";
import { buildCalendar, type FeedEvent } from "./ics.js";
import { hashPassword, randomToken, safeEqual, verifyPassword } from "./crypto.js";
import { one, q } from "./db.js";
import { bad, body, bool, color, HttpError, int, isoDate, json, notFound, Router, str, type RouteContext } from "./http.js";
import * as map from "./mappers.js";
import type { BookingRow, RoomRow, TeamRow } from "./mappers.js";
import { rateLimit } from "./rateLimit.js";

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
  const admin = await currentAdmin(req);
  return json({
    needsSetup: count!.n === 0,
    setupKeyConfigured: !!process.env.ADMIN_SETUP_KEY,
    admin,
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
     RETURNING id, email, name, is_super AS "isSuper"`,
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
  const admin = { id: row.id, email: row.email, name: row.name, isSuper: row.is_super };
  await logActivity({ teamId: null, action: "admin.login", summary: `${row.name} signed in`, actor: adminActor(admin, ip) });
  return json({ admin }, 200, { "set-cookie": await sessionCookie(row.id, req) });
});

router.post("/admin/logout", async () => json({ ok: true }, 200, { "set-cookie": clearCookie() }));

router.get("/admin/admins", async ({ req }) => {
  await requireSuper(req);
  const rows = await q<{ id: number; email: string; name: string; is_super: boolean; created_at: Date; last_login_at: Date | null; team_ids: number[] }>(
    `SELECT a.*, COALESCE(array_agg(ta.team_id) FILTER (WHERE ta.team_id IS NOT NULL), '{}') AS team_ids
       FROM admins a LEFT JOIN team_admins ta ON ta.admin_id = a.id
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
  for (const t of teams) await q("INSERT INTO team_admins (admin_id, team_id) VALUES ($1, $2)", [adminId, t.id]);
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
  const target = await one<{ id: number; name: string; is_super: boolean }>("SELECT id, name, is_super FROM admins WHERE id = $1", [Number(params.id)]);
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
  const row = await one<{ name: string; email: string }>("DELETE FROM admins WHERE id = $1 RETURNING name, email", [id]);
  if (row) await logActivity({ teamId: null, action: "admin.remove", summary: `Removed admin ${row.name} (${row.email})`, actor: adminActor(me, ip) });
  return json({ ok: true });
});

router.post("/admin/password", async ({ req, ip }) => {
  const me = await requireAdmin(req);
  const b = await body(req);
  const row = await one<{ password_hash: string }>("SELECT password_hash FROM admins WHERE id = $1", [me.id]);
  if (!(await verifyPassword(String(b.currentPassword ?? ""), row!.password_hash))) {
    throw bad("Your current password is incorrect.");
  }
  const next = String(b.newPassword ?? "");
  if (next.length < 10) throw bad("New password must be at least 10 characters.");
  await q("UPDATE admins SET password_hash = $1 WHERE id = $2", [await hashPassword(next), me.id]);
  await logActivity({ teamId: null, action: "admin.password", summary: `${me.name} changed their password`, actor: adminActor(me, ip) });
  return json({ ok: true });
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
  const { cols, params: p } = upsertColumns({ ...(await parseRoom(await body(req), team)), team_id: team.id });
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
  return json(await createBooking(await teamById(Number(params.id)), await body(req), { admin: true, ip, actor: adminActor(me, ip) }), 201);
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
  const b = await body(ctx.req);
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
    const b = await body(req);
    const { series, team, actor } = await access(req, params.token, ip, typeof b.staffName === "string" ? b.staffName.trim().slice(0, 120) : "");
    if (!admin) await rateLimit(`edit:${ip}`, 60, 3600);
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
