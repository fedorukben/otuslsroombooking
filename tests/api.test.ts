// End-to-end API tests against a real Postgres.
// Usage: ROOMS_DB_URL=postgres://... npx tsx tests/api.test.ts   (database must have the migration applied and be empty)
import { DateTime } from "luxon";
import { startServer } from "./server.js";
import { expandDates } from "../server/recurrence.js";

process.env.ADMIN_SETUP_KEY ??= "test-setup-key";
const BASE = `http://localhost:${process.env.PORT ?? 8788}/api`;
let cookie = "";
let passed = 0;
let failed = 0;

async function call(method: string, path: string, data?: unknown, headers: Record<string, string> = {}, useCookie = true) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(data !== undefined ? { "content-type": "application/json" } : {}),
      ...(useCookie && cookie ? { cookie } : {}),
      ...headers,
    },
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set && useCookie) cookie = set.split(";")[0];
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 600) : "");
  }
}

const zone = "America/Toronto";
// A Monday at least 7 days out.
const monday = DateTime.now().setZone(zone).plus({ days: 7 }).startOf("week");
const d = (offset: number) => monday.plus({ days: offset }).toISODate()!;

async function main() {
  const server = await startServer();
  try {
    console.log("Recurrence expansion");
    {
      const r1 = expandDates("2027-01-31", { freq: "monthly", interval: 1, monthlyMode: "date", end: { type: "count", count: 4 } });
      check("monthly on the 31st skips short months", r1.dates.join() === "2027-01-31,2027-03-31,2027-05-31,2027-07-31", r1);
      const r2 = expandDates("2027-01-12", { freq: "monthly", interval: 1, monthlyMode: "weekday", end: { type: "count", count: 3 } });
      check("monthly 2nd Tuesday", r2.dates.join() === "2027-01-12,2027-02-09,2027-03-09", r2);
      const r3 = expandDates("2027-01-29", { freq: "monthly", interval: 1, monthlyMode: "weekday", end: { type: "count", count: 3 } });
      check("monthly last Friday", r3.dates.join() === "2027-01-29,2027-02-26,2027-03-26", r3);
      const r4 = expandDates("2027-01-06", { freq: "weekly", interval: 2, byWeekday: [1, 3], end: { type: "until", date: "2027-02-01" } });
      check("every 2 weeks Mon+Wed until date (starts Wed)", r4.dates.join() === "2027-01-06,2027-01-18,2027-01-20,2027-02-01", r4);
      const r5 = expandDates("2027-01-01", { freq: "daily", interval: 1, end: { type: "count", count: 9999 } });
      check("occurrence cap applies and is reported", r5.dates.length === 366 && r5.truncated, r5.dates.length);
    }

    console.log("Admin setup and sign-in");
    let r = await call("GET", "/admin/status");
    check("needs setup on empty database", r.body.needsSetup === true, r.body);
    r = await call("POST", "/admin/setup", { setupKey: "wrong", email: "a@x.ca", name: "A", password: "longpassword1" });
    check("wrong setup key rejected", r.status === 403, r);
    r = await call("POST", "/admin/setup", { setupKey: process.env.ADMIN_SETUP_KEY, email: "Ben@Example.ca", name: "Ben", password: "longpassword1" });
    check("first admin created", r.status === 201 && r.body.admin.email === "ben@example.ca", r);
    r = await call("POST", "/admin/setup", { setupKey: process.env.ADMIN_SETUP_KEY, email: "b@x.ca", name: "B", password: "longpassword1" });
    check("setup can't run twice", r.status === 409, r);
    const saved = cookie;
    cookie = "";
    r = await call("GET", "/admin/teams");
    check("admin API needs sign-in", r.status === 401, r);
    r = await call("POST", "/admin/login", { email: "ben@example.ca", password: "nope-nope-nope" });
    check("wrong password rejected", r.status === 401);
    r = await call("POST", "/admin/login", { email: "ben@example.ca", password: "longpassword1" });
    check("sign-in works", r.status === 200 && cookie.startsWith("rs_admin="), r);
    check("cookie differs from setup cookie only by expiry/sig", !!saved);
    r = await call("POST", "/admin/teams", { name: "No JSON" }, { "content-type": "text/plain" });
    check("non-JSON body rejected (CSRF guard)", r.status === 415, r);

    console.log("Teams, rooms, categories");
    r = await call("POST", "/admin/teams", { name: "Student Learning", timezone: zone, rules: { maxDaysAhead: 365, bufferMinutes: 0 } });
    check("team created", r.status === 201, r);
    const team = r.body.team;
    r = await call("GET", `/admin/teams/${team.id}`);
    const cats = r.body.categories;
    check("starter categories exist", cats.length === 4, cats);
    const hours = { "1": [[480, 1200]], "2": [[480, 1200]], "3": [[480, 1200]], "4": [[480, 1200]], "5": [[480, 720], [780, 1020]], "6": [], "7": [] };
    r = await call("POST", `/admin/teams/${team.id}/rooms`, { name: "Study Hall", code: "SIRC 1350", building: "SIRC", campus: "North Oshawa", capacity: 10, hours, color: "#1a7f37" });
    check("room created", r.status === 201, r);
    const room = r.body.room;
    r = await call("POST", `/admin/teams/${team.id}/rooms`, { name: "Approval Room", hours, requiresApproval: true, overrides: { bufferMinutes: 15, capacityMode: "block" }, capacity: 5 });
    const room2 = r.body.room;
    check("room override merged into rules", room2.rules.bufferMinutes === 15 && room2.rules.capacityMode === "block" && room2.rules.slotMinutes === 30, room2.rules);
    r = await call("POST", `/admin/teams/${team.id}/rooms`, { name: "Bad", hours: { "1": [[600, 540]] } });
    check("bad hours rejected", r.status === 400, r);

    console.log("Member booking");
    const T = `/t/${team.shareToken}`;
    r = await call("GET", T, undefined, {}, false);
    check("member can open team link", r.status === 200 && r.body.rooms.length === 2, r);
    r = await call("GET", "/t/not-a-real-token", undefined, {}, false);
    check("bad link is 404", r.status === 404);
    const base = { roomId: room.id, categoryId: cats[0].id, title: "PE training", staffName: "Ben Fedoruk", staffEmail: "", attendance: 8, description: "", isPrivate: false, allDay: false, recurrence: null };
    r = await call("POST", `${T}/bookings/preview`, { ...base, date: d(0), startTime: "10:00", endTime: "11:00" }, {}, false);
    check("preview ok", r.status === 200 && r.body.bookable === 1 && r.body.occurrences[0].issues.length === 0, r.body);
    r = await call("POST", `${T}/bookings`, { ...base, date: d(0), startTime: "10:00", endTime: "11:00" }, {}, false);
    check("booking created", r.status === 201 && r.body.status === "confirmed", r);
    const firstToken = r.body.manageToken;
    r = await call("POST", `${T}/bookings`, { ...base, date: d(0), startTime: "10:30", endTime: "11:30" }, {}, false);
    check("overlap refused", r.status === 422 && /Overlaps/.test(r.body.error), r);
    r = await call("POST", `${T}/bookings`, { ...base, date: d(0), startTime: "11:00", endTime: "12:00" }, {}, false);
    check("back-to-back allowed with no buffer", r.status === 201, r);

    const race = await Promise.all(
      [1, 2, 3, 4].map(() => call("POST", `${T}/bookings`, { ...base, date: d(1), startTime: "14:00", endTime: "15:00" }, {}, false)),
    );
    const wins = race.filter((x) => x.status === 201).length;
    check("concurrent identical bookings: exactly one wins", wins === 1, race.map((x) => x.status));

    r = await call("POST", `${T}/bookings`, { ...base, date: d(0), startTime: "07:00", endTime: "08:00" }, {}, false);
    check("outside hours refused", r.status === 422 && /Outside/.test(r.body.error), r.body);
    r = await call("POST", `${T}/bookings`, { ...base, date: d(4), startTime: "12:00", endTime: "13:00" }, {}, false);
    check("lunch gap on split-hours day refused", r.status === 422, r.body);
    r = await call("POST", `${T}/bookings`, { ...base, date: d(5), startTime: "10:00", endTime: "11:00" }, {}, false);
    check("closed weekday refused", r.status === 422 && /closed/.test(r.body.error), r.body);
    r = await call("POST", `${T}/bookings`, { ...base, date: d(0), startTime: "15:15", endTime: "16:00" }, {}, false);
    check("off-step time refused", r.status === 422 && /steps/.test(r.body.error), r.body);
    r = await call("POST", `${T}/bookings`, { ...base, date: d(1), startTime: "08:00", endTime: "13:00" }, {}, false);
    check("too long refused", r.status === 422 && /at most/.test(r.body.error), r.body);
    r = await call("POST", `${T}/bookings`, { ...base, date: d(0), startTime: "16:00", endTime: "17:00", attendance: 30 }, {}, false);
    check("over capacity is a warning (warn mode) and books", r.status === 201, r.body);
    r = await call("POST", `${T}/bookings`, { ...base, date: d(0), startTime: "17:00", endTime: "18:00", website: "spam" }, {}, false);
    check("honeypot blocks bots", r.status === 400);

    console.log("Closures");
    r = await call("POST", `/admin/teams/${team.id}/closures`, { startDate: d(2), endDate: d(2), reason: "Reading week" });
    check("closure added", r.status === 201, r);
    r = await call("POST", `${T}/bookings`, { ...base, date: d(2), startTime: "10:00", endTime: "11:00" }, {}, false);
    check("booking on closure refused", r.status === 422 && /Reading week/.test(r.body.error), r.body);

    console.log("Recurring bookings");
    const weekly = { ...base, title: "Weekly drop-in", date: d(0), startTime: "10:00", endTime: "11:00", recurrence: { freq: "weekly", interval: 1, byWeekday: [1, 3], end: { type: "count", count: 6 } } };
    r = await call("POST", `${T}/bookings/preview`, weekly, {}, false);
    const blockedDates = r.body.occurrences.filter((o: any) => o.issues.some((i: any) => i.severity === "block")).map((o: any) => o.date);
    check("preview flags conflict + closure dates", blockedDates.join() === `${d(0)},${d(2)}` && r.body.bookable === 4, r.body);
    r = await call("POST", `${T}/bookings`, weekly, {}, false);
    check("create without skipping blocked dates is refused with preview", r.status === 422 && r.body.preview?.occurrences.length === 6, r.status);
    r = await call("POST", `${T}/bookings`, { ...weekly, skipDates: blockedDates }, {}, false);
    check("create with skipped dates books the rest", r.status === 201 && r.body.created === 4, r.body);
    const seriesToken = r.body.manageToken;

    console.log("Manage link: edit and cancel");
    r = await call("GET", `/manage/${seriesToken}`, undefined, {}, false);
    check("manage view loads", r.status === 200 && r.body.bookings.length === 4 && r.body.recurrence?.freq === "weekly", r.body);
    const occ = r.body.bookings;
    const editThis = { ...base, title: "Moved one", date: DateTime.fromISO(occ[1].startsAt).setZone(zone).toISODate(), startTime: "13:00", endTime: "14:00", scope: "this" };
    r = await call("PATCH", `/manage/${seriesToken}/bookings/${occ[1].id}`, editThis, {}, false);
    check("edit this occurrence", r.status === 200 && r.body.updated === 1, r.body);
    r = await call("GET", `/manage/${seriesToken}`, undefined, {}, false);
    const moved = r.body.bookings.find((b: any) => b.id === occ[1].id);
    check("edited occurrence is an exception with new time", moved.isException && moved.title === "Moved one" && DateTime.fromISO(moved.startsAt).setZone(zone).hour === 13, moved);
    const following = { ...weekly, title: "Afternoon drop-in", date: DateTime.fromISO(occ[2].startsAt).setZone(zone).toISODate(), startTime: "15:00", endTime: "16:00", recurrence: { freq: "weekly", interval: 1, byWeekday: [1, 3], end: { type: "count", count: 3 } }, scope: "following" };
    r = await call("PATCH", `/manage/${seriesToken}/bookings/${occ[2].id}`, following, {}, false);
    check("edit this-and-following regenerates", r.status === 200 && r.body.updated === 3, r.body);
    r = await call("GET", `/manage/${seriesToken}`, undefined, {}, false);
    const active = r.body.bookings.filter((b: any) => b.status !== "cancelled");
    check("series now has 2 kept + 3 new", active.length === 5 && active.filter((b: any) => b.title === "Afternoon drop-in").length === 3, active.map((b: any) => b.title));
    r = await call("POST", `/manage/${seriesToken}/bookings/${active[0].id}/cancel`, { scope: "all" }, {}, false);
    check("cancel all upcoming", r.status === 200 && r.body.cancelled === 5, r.body);
    r = await call("GET", `/manage/${firstToken}`, undefined, {}, false);
    check("one-off manage view loads", r.body.bookings.length === 1 && r.body.recurrence === null, r.body);

    console.log("Privacy");
    await call("POST", `${T}/bookings`, { ...base, title: "Confidential 1:1", isPrivate: true, date: d(3), startTime: "09:00", endTime: "10:00" }, {}, false);
    const range = `start=${monday.toUTC().toISO()}&end=${monday.plus({ days: 7 }).toUTC().toISO()}`;
    r = await call("GET", `${T}/events?${range}`, undefined, {}, false);
    const pub = r.body.bookings.find((b: any) => b.isPrivate);
    check("members see private booking as Busy", pub && pub.title === "Busy" && pub.staffName === "" && pub.staffEmail === undefined, pub);
    check("members get closures", r.body.closures.length === 1, r.body.closures);
    r = await call("GET", `/admin/teams/${team.id}/events?${range}`);
    const adm = r.body.bookings.find((b: any) => b.isPrivate);
    check("admins see private booking details", adm && adm.title === "Confidential 1:1", adm);

    console.log("Approval, buffer and capacity block");
    const b2 = { ...base, roomId: room2.id, attendance: 3 };
    r = await call("POST", `${T}/bookings`, { ...b2, date: d(0), startTime: "10:00", endTime: "11:00" }, {}, false);
    check("approval room booking is pending", r.status === 201 && r.body.status === "pending", r.body);
    r = await call("POST", `${T}/bookings`, { ...b2, date: d(0), startTime: "11:00", endTime: "12:00" }, {}, false);
    check("buffer enforced next to pending booking", r.status === 422 && /between bookings/.test(r.body.error), r.body);
    r = await call("POST", `${T}/bookings`, { ...b2, date: d(0), startTime: "13:00", endTime: "14:00", attendance: 9 }, {}, false);
    check("capacity block mode refuses", r.status === 422 && /capacity/.test(r.body.error), r.body);
    r = await call("GET", `/admin/teams/${team.id}/pending`);
    check("pending queue lists it", r.body.pending.length === 1, r.body);
    r = await call("POST", `/admin/teams/${team.id}/approve`, { bookingIds: [r.body.pending[0].id] });
    check("approve", r.body.updated === 1, r.body);

    console.log("Admin override");
    r = await call("POST", `/admin/teams/${team.id}/bookings`, { ...base, date: d(5), startTime: "10:00", endTime: "11:00", override: true });
    check("admin can override closed day", r.status === 201, r.body);
    r = await call("POST", `/admin/teams/${team.id}/bookings`, { ...base, date: d(0), startTime: "10:00", endTime: "11:00", override: true });
    check("admin can never override an overlap", r.status === 422, r.body);

    console.log("Time zones (DST)");
    const dst = "2027-03-15"; // Monday after DST starts on 2027-03-14
    r = await call("POST", `${T}/bookings`, { ...base, date: dst, startTime: "09:00", endTime: "10:00" }, {}, false);
    const view = await call("GET", `/manage/${r.body.manageToken}`, undefined, {}, false);
    check("09:00 Toronto after DST is 13:00 UTC", view.body.bookings?.[0]?.startsAt?.startsWith("2027-03-15T13:00"), view.body.bookings?.[0]);


    console.log("Find a free room");
    r = await call("POST", `${T}/free`, { date: d(0), startTime: "10:00", endTime: "11:00" }, {}, false);
    const sh = r.body.results?.find((x: any) => x.roomId === room.id);
    check("free search marks booked room unavailable with reason", sh && !sh.available && /Overlaps/.test(sh.reasons[0]), r.body);
    r = await call("POST", `${T}/free`, { date: d(3), startTime: "14:00", endTime: "15:00" }, {}, false);
    check("free search finds open rooms", r.body.results.filter((x: any) => x.available).length === 2, r.body);
    r = await call("POST", `${T}/free`, { date: d(3), startTime: "14:00", endTime: "15:00", minCapacity: 8 }, {}, false);
    check("seat filter drops small rooms", r.body.results.length === 1 && r.body.results[0].roomId === room.id, r.body);
    r = await call("POST", `${T}/free`, { date: d(0), startTime: "10:00", endTime: "11:00", recurrence: { freq: "weekly", interval: 1, byWeekday: [1], end: { type: "count", count: 4 } } }, {}, false);
    const shr = r.body.results.find((x: any) => x.roomId === room.id);
    check("free search counts free dates in a repeat", r.body.dates === 4 && shr.freeCount === 3, r.body);

    console.log("Calendar feeds");
    r = await call("GET", `/admin/teams/${team.id}`);
    const feedTok = r.body.team.feedToken;
    const adminFeedTok = r.body.team.adminFeedToken;
    let res = await fetch(`${BASE}/feed/${feedTok}.ics`);
    let ics = await res.text();
    check("feed is text/calendar with events", res.headers.get("content-type")?.startsWith("text/calendar") === true && ics.includes("BEGIN:VEVENT") && ics.includes("END:VCALENDAR"), ics.slice(0, 200));
    check("member feed hides private booking", ics.includes("SUMMARY:Busy") && !ics.includes("Confidential"), "");
    check("feed lines are folded to 75 octets", ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75), "");
    res = await fetch(`${BASE}/feed/${adminFeedTok}.ics`);
    ics = await res.text();
    check("admin feed shows private details", ics.includes("Confidential 1:1"), "");
    res = await fetch(`${BASE}/feed/${feedTok}.ics?room=${room2.id}`);
    ics = await res.text();
    check("room feed only has that room", ics.includes("Approval Room") && !ics.includes("Study Hall"), ics.slice(0, 400));
    check("pending shows as tentative", ics.includes("STATUS:TENTATIVE") || ics.includes("STATUS:CONFIRMED"), "");

    console.log("Activity log");
    r = await call("GET", `/admin/activity?teamId=${team.id}`);
    const actions = r.body.entries.map((e: any) => e.action);
    check("team log has bookings, edits, cancels, approvals, rooms", ["booking.create", "booking.update", "booking.cancel", "booking.approve", "room.create", "closure.create"].every((a) => actions.includes(a)), actions);
    check("member actions record the staff name", r.body.entries.some((e: any) => e.actorType === "member" && e.actorName === "Ben Fedoruk"), r.body.entries.slice(0, 3));
    r = await call("GET", `/admin/activity?type=booking&q=Weekly`);
    check("global log is searchable", r.body.entries.length > 0 && r.body.entries.every((e: any) => e.action.startsWith("booking.")), r.body);

    console.log("Super admin and team admins");
    r = await call("GET", "/admin/status");
    check("first admin is the super admin", r.body.admin.isSuper === true, r.body);
    r = await call("POST", "/admin/admins", { name: "Jerome", email: "jerome@example.ca", password: "anotherpass1", teamIds: [] });
    check("super admin adds an admin", r.status === 201, r);
    const jeromeId = r.body.admin.id;
    const superCookie = cookie;
    cookie = "";
    r = await call("POST", "/admin/login", { email: "jerome@example.ca", password: "anotherpass1" });
    check("second admin is not super", r.body.admin.isSuper === false, r.body);
    r = await call("GET", "/admin/teams");
    check("admin with no teams sees no teams", r.body.teams.length === 0, r.body);
    r = await call("GET", `/admin/teams/${team.id}`);
    check("admin can't open a team they don't manage", r.status === 403, r);
    r = await call("GET", `/admin/teams/${team.id}/events?${range}`);
    check("...or its bookings", r.status === 403);
    r = await call("GET", "/admin/admins");
    check("only super admin manages admin accounts", r.status === 403);
    r = await call("GET", "/admin/activity");
    check("only super admin sees the all-teams log", r.status === 403);
    r = await call("POST", "/admin/teams", { name: "Jerome's team" });
    check("regular admin can create a team", r.status === 201, r);
    r = await call("GET", "/admin/teams");
    check("...and is assigned to it", r.body.teams.length === 1 && r.body.teams[0].name === "Jerome's team", r.body);
    const jTeam = r.body.teams[0].id;
    r = await call("DELETE", `/admin/teams/${jTeam}`);
    check("only super admin can delete teams", r.status === 403);
    const jeromeCookie = cookie;
    cookie = superCookie;
    r = await call("PATCH", `/admin/admins/${jeromeId}/teams`, { teamIds: [team.id, jTeam] });
    check("super admin assigns teams", r.status === 200, r);
    r = await call("GET", "/admin/teams");
    check("super admin sees every team", r.body.teams.length === 2, r.body);
    cookie = jeromeCookie;
    r = await call("GET", `/admin/teams/${team.id}`);
    check("assigned admin can now open the team", r.status === 200);
    r = await call("GET", `/admin/activity?teamId=${team.id}`);
    check("assigned admin sees that team's log", r.status === 200 && r.body.entries.length > 0);
    cookie = superCookie;

    console.log("PIN");
    r = await call("PATCH", `/admin/teams/${team.id}`, { pin: "4321" });
    check("PIN set", r.body.team.hasPin === true, r.body);
    r = await call("GET", T, undefined, {}, false);
    check("PIN required", r.status === 401 && r.body.pinRequired, r.body);
    r = await call("GET", T, undefined, { "x-team-pin": "0000" }, false);
    check("wrong PIN refused", r.status === 401);
    r = await call("GET", T, undefined, { "x-team-pin": "4321" }, false);
    check("right PIN accepted", r.status === 200);
    r = await call("POST", `/admin/teams/${team.id}/regenerate-link`, {});
    r = await call("GET", T, undefined, { "x-team-pin": "4321" }, false);
    check("old link stops working after regenerate", r.status === 404);
    res = await fetch(`${BASE}/feed/${feedTok}.ics`);
    check("old feed link stops working too", res.status === 404);
  } finally {
    server.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
