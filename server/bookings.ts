import { DateTime } from "luxon";
import type { BookingInput, BookingStatus, CreateResult, EditScope, Issue, OccurrencePreview, PreviewResult } from "../shared/types.js";
import { db, one, q, type Queryable, tx } from "./db.js";
import { randomToken } from "./crypto.js";
import { bad, bool, HttpError, int, isoDate, notFound, str } from "./http.js";
import { effectiveRules, type BookingRow, type RoomRow, type TeamRow } from "./mappers.js";
import { logActivity, type Actor } from "./activity.js";
import { expandDates, parseRecurrence } from "./recurrence.js";

// ---------- input parsing ----------

function parseTime(v: unknown, field: string): number {
  if (typeof v !== "string" || !/^\d{2}:\d{2}$/.test(v)) throw bad(`${field} must be a time like 09:30.`);
  const [h, m] = v.split(":").map(Number);
  if (h > 23 || m > 59) throw bad(`${field} is not a valid time.`);
  return h * 60 + m;
}

export interface ParsedInput {
  roomId: number;
  categoryId: number;
  title: string;
  staffName: string;
  staffEmail: string;
  attendance: number | null;
  description: string;
  isPrivate: boolean;
  allDay: boolean;
  date: string;
  startMin: number;
  endMin: number;
  recurrence: ReturnType<typeof parseRecurrence>;
  skipDates: Set<string>;
  override: boolean;
}

export function parseBookingInput(raw: Partial<BookingInput>, team: TeamRow, admin: boolean): ParsedInput {
  if (raw.website) throw bad("Your booking could not be submitted.");
  const date = isoDate(raw.date, "Date");
  const allDay = bool(raw.allDay);
  const startMin = allDay ? 0 : parseTime(raw.startTime, "Start time");
  const endMin = allDay ? 0 : parseTime(raw.endTime, "End time");
  if (!allDay && endMin <= startMin) throw bad("The end time must be after the start time.");

  const staffEmail = str(raw.staffEmail, "Email", { max: 200 });
  if (staffEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(staffEmail)) throw bad("Email doesn't look right.");
  const attendance = int(raw.attendance, "Expected attendance", { min: 1, max: 100000, nullable: true });
  const description = str(raw.description, "Description", { max: 2000 });

  if (!admin) {
    if (team.require_email && !staffEmail) throw bad("Email is required.");
    if (team.require_attendance && attendance === null) throw bad("Expected attendance is required.");
    if (team.require_description && !description) throw bad("Description is required.");
  }

  return {
    roomId: int(raw.roomId, "Room", { min: 1 })!,
    categoryId: int(raw.categoryId, "Category", { min: 1 })!,
    title: str(raw.title, "Title", { max: 150, required: true }),
    staffName: str(raw.staffName, "Staff member name", { max: 120, required: true }),
    staffEmail,
    attendance,
    description,
    isPrivate: bool(raw.isPrivate),
    allDay,
    date,
    startMin,
    endMin,
    recurrence: parseRecurrence(raw.recurrence, date),
    skipDates: new Set((Array.isArray(raw.skipDates) ? raw.skipDates : []).filter((d) => typeof d === "string")),
    override: admin && bool(raw.override),
  };
}

// ---------- time helpers ----------

/** Local wall-clock time on a date in a zone. Uses set() rather than adding minutes so DST days are right. */
function at(date: string, minutes: number, zone: string): DateTime {
  const day = DateTime.fromISO(date, { zone }).startOf("day");
  if (minutes >= 1440) return day.plus({ days: 1 }).startOf("day");
  return day.set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 });
}

const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fmtRanges = (ranges: [number, number][]) => ranges.map(([a, b]) => `${hm(a)}–${b >= 1440 ? "24:00" : hm(b)}`).join(", ");

// ---------- log text ----------

function when(input: ParsedInput, zone: string, count: number): string {
  const d = DateTime.fromISO(input.date, { zone }).toFormat("ccc LLL d, yyyy");
  const t = input.allDay ? "all day" : `${hm(input.startMin)}–${hm(input.endMin)}`;
  return `${d} ${t}${count > 1 ? ` (+${count - 1} more)` : ""}`;
}

// ---------- preview / validation ----------

interface Occ {
  date: string;
  start: DateTime;
  end: DateTime;
  issues: Issue[];
  skipped: boolean;
}

interface Context {
  team: TeamRow;
  admin: boolean;
}

export async function loadRoom(client: Queryable, teamId: number, roomId: number): Promise<RoomRow> {
  const room = await one<RoomRow>("SELECT * FROM rooms WHERE id = $1 AND team_id = $2", [roomId, teamId], client);
  if (!room) throw notFound("That room doesn't exist in this team.");
  return room;
}

async function evaluate(
  client: Queryable,
  ctx: Context,
  input: ParsedInput,
  excludeIds: number[],
): Promise<{ occs: Occ[]; truncated: boolean; room: RoomRow }> {
  const { team, admin } = ctx;
  const zone = team.timezone;
  const room = await loadRoom(client, team.id, input.roomId);
  // categoryId 0 = availability-only check (used by "find a free room").
  const category = input.categoryId
    ? await one<{ id: number; active: boolean; name: string }>(
        "SELECT id, active, name FROM categories WHERE id = $1 AND team_id = $2",
        [input.categoryId, team.id],
        client,
      )
    : null;
  if (input.categoryId && !category) throw bad("Choose a category.");
  const rules = effectiveRules(team, room);
  const { dates, truncated } = expandDates(input.date, input.recurrence);
  if (!dates.length) throw bad("That repeat pattern doesn't produce any dates.");

  const now = DateTime.now().setZone(zone);
  const lastAllowedDate = now.startOf("day").plus({ days: rules.maxDaysAhead });

  const closures = await q<{ start_date: string; end_date: string; reason: string; room_id: number | null }>(
    `SELECT to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date, reason, room_id
       FROM closures
      WHERE team_id = $1 AND (room_id IS NULL OR room_id = $2) AND end_date >= $3 AND start_date <= $4`,
    [team.id, room.id, dates[0], dates[dates.length - 1]],
    client,
  );

  const occs: Occ[] = dates.map((date) => {
    const weekday = DateTime.fromISO(date).weekday;
    const ranges = (room.hours?.[String(weekday)] ?? []) as [number, number][];
    const issues: Issue[] = [];
    let startMin = input.startMin;
    let endMin = input.endMin;
    const ruleIssue = (code: Issue["code"], message: string) => issues.push({ code, message, severity: "block" });

    if (input.allDay) {
      if (ranges.length) {
        startMin = Math.min(...ranges.map((r) => r[0]));
        endMin = Math.max(...ranges.map((r) => r[1]));
      } else {
        startMin = 0;
        endMin = 1440;
      }
    }
    if (!ranges.length) {
      ruleIssue("closed", "The room is closed on this day of the week.");
    } else if (!input.allDay && !ranges.some(([a, b]) => startMin >= a && endMin <= b)) {
      ruleIssue("outside_hours", `Outside the room's hours (${fmtRanges(ranges)}).`);
    }
    const closure = closures.find((c) => date >= c.start_date && date <= c.end_date);
    if (closure) ruleIssue("closure", `Closed${closure.room_id ? " (this room)" : ""}: ${closure.reason || "closure"}.`);

    const start = at(date, startMin, zone);
    const end = at(date, endMin, zone);
    const minutes = Math.round(end.diff(start, "minutes").minutes);

    if (start < now) ruleIssue("past", "This time has already passed.");
    if (DateTime.fromISO(date, { zone }) > lastAllowedDate) {
      ruleIssue("too_far", `Bookings can only be made up to ${rules.maxDaysAhead} days ahead.`);
    }
    if (!input.allDay) {
      if (minutes < rules.minMinutes) ruleIssue("too_short", `Bookings must be at least ${rules.minMinutes} minutes.`);
      if (startMin % rules.slotMinutes || endMin % rules.slotMinutes) {
        ruleIssue("step", `Start and end times must be on ${rules.slotMinutes}-minute steps.`);
      }
    }
    if (minutes > rules.maxMinutes) ruleIssue("too_long", `Bookings can be at most ${rules.maxMinutes} minutes.`);
    if (!room.active) ruleIssue("inactive", "This room isn't taking bookings.");
    if (category && !category.active) ruleIssue("category", `The "${category.name}" category is no longer available.`);
    if (category && room.allowed_category_ids?.length && !room.allowed_category_ids.includes(category.id)) {
      ruleIssue("category", `This room doesn't accept "${category.name}" bookings.`);
    }
    if (room.capacity && input.attendance && input.attendance > room.capacity) {
      issues.push({
        code: "capacity",
        message: `Expected attendance (${input.attendance}) is over the room's capacity (${room.capacity}).`,
        severity: rules.capacityMode === "block" ? "block" : "warn",
      });
    }
    return { date, start, end, issues, skipped: input.skipDates.has(date) };
  });

  // Overlaps and buffers against existing bookings in this room.
  const buffer = rules.bufferMinutes;
  const windowStart = occs[0].start.minus({ minutes: buffer });
  const windowEnd = occs[occs.length - 1].end.plus({ minutes: buffer });
  const existing = await q<{ id: number; starts_at: Date; ends_at: Date; title: string; is_private: boolean }>(
    `SELECT id, starts_at, ends_at, title, is_private FROM bookings
      WHERE room_id = $1 AND status <> 'cancelled' AND NOT (id = ANY($2::int[]))
        AND starts_at < $4 AND ends_at > $3
      ORDER BY starts_at`,
    [room.id, excludeIds, windowStart.toJSDate(), windowEnd.toJSDate()],
    client,
  );
  for (const occ of occs) {
    const s = occ.start.toMillis();
    const e = occ.end.toMillis();
    for (const b of existing) {
      const bs = b.starts_at.getTime();
      const be = b.ends_at.getTime();
      if (bs < e && be > s) {
        const label = b.is_private && !admin ? "another booking" : `"${b.title}"`;
        const time = `${DateTime.fromJSDate(b.starts_at).setZone(zone).toFormat("HH:mm")}–${DateTime.fromJSDate(b.ends_at).setZone(zone).toFormat("HH:mm")}`;
        occ.issues.unshift({ code: "conflict", message: `Overlaps ${label} (${time}).`, severity: "block" });
        break;
      }
      if (buffer && bs < e + buffer * 60000 && be > s - buffer * 60000) {
        occ.issues.push({ code: "buffer", message: `Needs ${buffer} minutes between bookings.`, severity: "block" });
        break;
      }
    }
  }

  // Admin override: rule problems become warnings. Overlaps are never overridable.
  if (input.override) {
    for (const occ of occs) {
      for (const issue of occ.issues) {
        if (issue.code !== "conflict" && issue.severity === "block") {
          issue.severity = "warn";
          issue.message = `Overridden: ${issue.message}`;
        }
      }
    }
  }
  return { occs, truncated, room };
}

function toPreview(occs: Occ[], truncated: boolean, willBePending: boolean): PreviewResult {
  const occurrences: OccurrencePreview[] = occs.map((o) => ({
    date: o.date,
    startsAt: o.start.toUTC().toISO()!,
    endsAt: o.end.toUTC().toISO()!,
    issues: o.issues,
  }));
  const bookable = occs.filter((o) => !o.skipped && !o.issues.some((i) => i.severity === "block")).length;
  return { occurrences, bookable, willBePending, truncated };
}

export async function preview(team: TeamRow, raw: Partial<BookingInput>, admin: boolean, excludeIds: number[] = []): Promise<PreviewResult> {
  const input = parseBookingInput(raw, team, admin);
  const { occs, truncated, room } = await evaluate(db(), { team, admin }, input, excludeIds);
  return toPreview(occs, truncated, room.requires_approval && !admin);
}

/** Occurrences to write, or a 422 with the preview if something unskipped is blocked. */
function selectBookable(occs: Occ[], truncated: boolean, willBePending: boolean): Occ[] {
  const blocked = occs.filter((o) => !o.skipped && o.issues.some((i) => i.severity === "block"));
  if (blocked.length) {
    const msg =
      occs.length === 1
        ? blocked[0].issues.find((i) => i.severity === "block")!.message
        : `${blocked.length} of the dates can't be booked. Skip them or change the booking.`;
    throw new HttpError(422, msg, { preview: toPreview(occs, truncated, willBePending) });
  }
  const ok = occs.filter((o) => !o.skipped);
  if (!ok.length) throw bad("There are no dates left to book.");
  return ok;
}

async function insertOccurrences(
  client: Queryable,
  teamId: number,
  seriesId: number,
  input: ParsedInput,
  occs: Occ[],
  status: BookingStatus,
  isException = false,
) {
  // Chunked multi-row insert.
  const cols = [
    "team_id", "room_id", "series_id", "category_id", "title", "staff_name", "staff_email", "attendance",
    "description", "is_private", "all_day", "starts_at", "ends_at", "status", "is_exception",
  ];
  for (let i = 0; i < occs.length; i += 100) {
    const chunk = occs.slice(i, i + 100);
    const params: unknown[] = [];
    const rows = chunk.map((o) => {
      const vals = [
        teamId, input.roomId, seriesId, input.categoryId, input.title, input.staffName, input.staffEmail,
        input.attendance, input.description, input.isPrivate, input.allDay, o.start.toJSDate(), o.end.toJSDate(),
        status, isException,
      ];
      const placeholders = vals.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${placeholders.join(",")})`;
    });
    await client.query(`INSERT INTO bookings (${cols.join(",")}) VALUES ${rows.join(",")}`, params);
  }
}

export async function createBooking(
  team: TeamRow,
  raw: Partial<BookingInput>,
  opts: { admin: boolean; ip: string; actor: Actor; accountId?: number },
): Promise<CreateResult> {
  const input = parseBookingInput(raw, team, opts.admin);
  return tx(async (client) => {
    const { occs, truncated, room } = await evaluate(client, { team, admin: opts.admin }, input, []);
    const status: BookingStatus = room.requires_approval && !opts.admin ? "pending" : "confirmed";
    const ok = selectBookable(occs, truncated, status === "pending");
    const token = randomToken(32);
    const series = await one<{ id: number }>(
      `INSERT INTO booking_series (team_id, manage_token, recurrence, created_by_admin, creator_ip, account_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [team.id, token, input.recurrence ? JSON.stringify(input.recurrence) : null, opts.admin, opts.ip, opts.accountId ?? null],
      client,
    );
    await insertOccurrences(client, team.id, series!.id, input, ok, status);
    const skipped = occs.length - ok.length;
    await logActivity(
      {
        teamId: team.id,
        action: "booking.create",
        actor: opts.actor,
        summary: `Booked "${input.title}" in ${room.name}, ${when(input, team.timezone, ok.length)}${status === "pending" ? " — pending approval" : ""}${skipped ? `, ${skipped} date(s) skipped` : ""}${input.override ? " (rules overridden)" : ""}`,
        details: { seriesId: series!.id, staffName: input.staffName, count: ok.length, private: input.isPrivate },
      },
      client,
    );
    return { manageToken: token, seriesId: series!.id, created: ok.length, status };
  });
}

// ---------- editing an existing series ----------

export interface SeriesRow {
  id: number;
  team_id: number;
  manage_token: string;
  recurrence: any;
}

async function targetRows(client: Queryable, series: SeriesRow, bookingId: number, scope: EditScope): Promise<BookingRow[]> {
  const target = await one<BookingRow>(
    "SELECT * FROM bookings WHERE id = $1 AND series_id = $2 AND status <> 'cancelled' FOR UPDATE",
    [bookingId, series.id],
    client,
  );
  if (!target) throw notFound("That booking doesn't exist or was cancelled.");
  if (scope === "this") return [target];
  const rows =
    scope === "following"
      ? await q<BookingRow>(
          "SELECT * FROM bookings WHERE series_id = $1 AND status <> 'cancelled' AND starts_at >= $2 ORDER BY starts_at FOR UPDATE",
          [series.id, target.starts_at],
          client,
        )
      : await q<BookingRow>(
          "SELECT * FROM bookings WHERE series_id = $1 AND status <> 'cancelled' AND (ends_at > NOW() OR id = $2) ORDER BY starts_at FOR UPDATE",
          [series.id, bookingId],
          client,
        );
  return rows;
}

function parseScope(v: unknown): EditScope {
  if (v === "this" || v === "following" || v === "all") return v;
  throw bad("Choose which bookings to change.");
}

export async function previewEdit(team: TeamRow, series: SeriesRow, bookingId: number, raw: any, admin: boolean): Promise<PreviewResult> {
  const scope = parseScope(raw.scope);
  const rows = await targetRows(db(), series, bookingId, scope);
  const input = { ...raw, recurrence: scope === "this" ? null : raw.recurrence };
  return preview(team, input, admin, rows.map((r) => r.id));
}

export async function editSeries(
  team: TeamRow,
  series: SeriesRow,
  bookingId: number,
  raw: any,
  admin: boolean,
  actor: Actor,
): Promise<{ updated: number; status: BookingStatus }> {
  const scope = parseScope(raw.scope);
  const input = parseBookingInput({ ...raw, recurrence: scope === "this" ? null : raw.recurrence }, team, admin);
  return tx(async (client) => {
    const rows = await targetRows(client, series, bookingId, scope);
    const { occs, truncated, room } = await evaluate(client, { team, admin }, input, rows.map((r) => r.id));
    const wasPending = rows.some((r) => r.status === "pending");
    const status: BookingStatus =
      room.requires_approval && (!admin ? true : wasPending) ? "pending" : "confirmed";
    const ok = selectBookable(occs, truncated, status === "pending");
    const scopeText = { this: "one booking", following: "this and following", all: "all upcoming" }[scope];
    const before = rows[0];
    await logActivity(
      {
        teamId: team.id,
        action: "booking.update",
        actor,
        summary: `Changed "${before.title}" (${scopeText}) → "${input.title}" in ${room.name}, ${when(input, team.timezone, ok.length)}${status === "pending" ? " — pending approval" : ""}`,
        details: { seriesId: series.id, bookingId, scope, replaced: rows.length, now: ok.length },
      },
      client,
    );

    if (scope === "this") {
      const o = ok[0];
      await client.query(
        `UPDATE bookings SET room_id=$1, category_id=$2, title=$3, staff_name=$4, staff_email=$5, attendance=$6,
           description=$7, is_private=$8, all_day=$9, starts_at=$10, ends_at=$11, status=$12,
           is_exception=$13, updated_at=NOW()
         WHERE id=$14`,
        [
          input.roomId, input.categoryId, input.title, input.staffName, input.staffEmail, input.attendance,
          input.description, input.isPrivate, input.allDay, o.start.toJSDate(), o.end.toJSDate(), status,
          !!series.recurrence, rows[0].id,
        ],
      );
      return { updated: 1, status };
    }
    // following / all: replace the affected occurrences with a freshly generated set.
    await client.query("DELETE FROM bookings WHERE id = ANY($1::int[])", [rows.map((r) => r.id)]);
    await insertOccurrences(client, team.id, series.id, input, ok, status);
    await client.query("UPDATE booking_series SET recurrence = $1 WHERE id = $2", [
      input.recurrence ? JSON.stringify(input.recurrence) : null,
      series.id,
    ]);
    return { updated: ok.length, status };
  });
}

export async function cancelSeries(series: SeriesRow, bookingId: number, rawScope: unknown, actor: Actor): Promise<{ cancelled: number }> {
  const scope = parseScope(rawScope);
  return tx(async (client) => {
    const rows = await targetRows(client, series, bookingId, scope);
    await client.query(
      "UPDATE bookings SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = ANY($1::int[])",
      [rows.map((r) => r.id)],
    );
    const first = rows[0];
    const zone = (await one<{ timezone: string }>("SELECT timezone FROM teams WHERE id = $1", [series.team_id], client))?.timezone ?? "UTC";
    const room = await one<{ name: string }>("SELECT name FROM rooms WHERE id = $1", [first.room_id], client);
    await logActivity(
      {
        teamId: series.team_id,
        action: "booking.cancel",
        actor,
        summary: `Cancelled "${first.title}" in ${room?.name ?? "a room"}, ${DateTime.fromJSDate(first.starts_at).setZone(zone).toFormat("ccc LLL d, yyyy HH:mm")}${rows.length > 1 ? ` (+${rows.length - 1} more)` : ""}`,
        details: { seriesId: series.id, bookingIds: rows.map((r) => r.id), scope },
      },
      client,
    );
    return { cancelled: rows.length };
  });
}

export async function seriesBookings(seriesId: number): Promise<BookingRow[]> {
  return q<BookingRow>(
    `SELECT b.*, (s.recurrence IS NOT NULL) AS recurring
       FROM bookings b JOIN booking_series s ON s.id = b.series_id
      WHERE b.series_id = $1 ORDER BY b.starts_at`,
    [seriesId],
  );
}

// ---------- find a free room ----------

export interface FreeRoomResult {
  roomId: number;
  available: boolean;
  /** For repeats: how many of the dates are free. */
  freeCount: number;
  total: number;
  reasons: string[];
}

export async function findFree(team: TeamRow, raw: any, admin: boolean): Promise<{ results: FreeRoomResult[]; dates: number }> {
  const date = isoDate(raw.date, "Date");
  const allDay = bool(raw.allDay);
  const startMin = allDay ? 0 : parseTime(raw.startTime, "Start time");
  const endMin = allDay ? 0 : parseTime(raw.endTime, "End time");
  if (!allDay && endMin <= startMin) throw bad("The end time must be after the start time.");
  const minCapacity = int(raw.minCapacity, "Seats", { min: 1, max: 100000, nullable: true });
  const recurrence = parseRecurrence(raw.recurrence, date);
  const rooms = await q<RoomRow>("SELECT * FROM rooms WHERE team_id = $1 AND active ORDER BY sort_order, name", [team.id]);
  const results: FreeRoomResult[] = [];
  let total = 1;
  for (const room of rooms) {
    if (minCapacity && room.capacity !== null && room.capacity < minCapacity) continue;
    const input: ParsedInput = {
      roomId: room.id,
      categoryId: 0,
      title: "",
      staffName: "",
      staffEmail: "",
      attendance: minCapacity,
      description: "",
      isPrivate: false,
      allDay,
      date,
      startMin,
      endMin,
      recurrence,
      skipDates: new Set(),
      override: false,
    };
    const { occs } = await evaluate(db(), { team, admin }, input, []);
    total = occs.length;
    const blocked = occs.filter((o) => o.issues.some((i) => i.severity === "block"));
    const reasons = [...new Set(blocked.flatMap((o) => o.issues.filter((i) => i.severity === "block").map((i) => i.message)))].slice(0, 3);
    results.push({ roomId: room.id, available: blocked.length === 0, freeCount: occs.length - blocked.length, total: occs.length, reasons });
  }
  results.sort((a, b) => Number(b.available) - Number(a.available) || b.freeCount - a.freeCount);
  return { results, dates: total };
}
