import { DateTime } from "luxon";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { CalendarBooking, Category, Closure, PublicTeam, Room } from "../../shared/types";
import { adminEndpoints, api, errorText, memberEndpoints, type Endpoints } from "../api";
import { fmtTime, localDate, roomLabel, roomLocation, todayIn } from "../lib/time";
import { brandStyle } from "./TeamPage";

/**
 * Printable schedule (and "Save as PDF" through the browser's print dialog).
 * Members: /print/t/:token   Admins: /admin/teams/:id/print
 */
export function PrintPage({ admin = false }: { admin?: boolean }) {
  const { token = "", id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const [meta, setMeta] = useState<{ team: PublicTeam; rooms: Room[]; categories: Category[] } | null>(null);
  const [data, setData] = useState<{ bookings: CalendarBooking[]; closures: Closure[] } | null>(null);
  const [error, setError] = useState("");

  const endpoints: Endpoints = admin ? adminEndpoints(Number(id)) : memberEndpoints(token);
  const zone = meta?.team.timezone ?? "America/Toronto";
  const from = params.get("from") ?? todayIn(zone);
  const to = params.get("to") ?? from;
  const roomFilter = params.get("room") ?? "";
  const layout = params.get("layout") === "day" ? "day" : "room";
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  useEffect(() => {
    (admin ? api(`/admin/teams/${id}`) : api(`/t/${token}`, { headers: endpoints.headers }))
      .then(setMeta)
      .catch((e) => setError(errorText(e)));
  }, [admin, id, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const days = useMemo(() => {
    const out: string[] = [];
    let d = DateTime.fromISO(from);
    const end = DateTime.fromISO(to < from ? from : to);
    while (d <= end && out.length < 31) {
      out.push(d.toISODate()!);
      d = d.plus({ days: 1 });
    }
    return out;
  }, [from, to]);

  useEffect(() => {
    if (!meta) return;
    const start = DateTime.fromISO(days[0], { zone }).startOf("day");
    const end = DateTime.fromISO(days[days.length - 1], { zone }).plus({ days: 1 }).startOf("day");
    setData(null);
    api(`${endpoints.events}?start=${encodeURIComponent(start.toUTC().toISO()!)}&end=${encodeURIComponent(end.toUTC().toISO()!)}${roomFilter ? `&roomId=${roomFilter}` : ""}`, {
      headers: endpoints.headers,
    })
      .then(setData)
      .catch((e) => setError(errorText(e)));
  }, [meta, days, roomFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <main className="page"><p className="error">{error}</p></main>;
  if (!meta) return <main className="page"><p className="muted">Loading…</p></main>;

  const rooms = meta.rooms.filter((r) => !roomFilter || String(r.id) === roomFilter);
  const cat = new Map(meta.categories.map((c) => [c.id, c.name]));
  const bookingsFor = (roomId: number, date: string) =>
    (data?.bookings ?? []).filter((b) => b.roomId === roomId && localDate(b.startsAt, zone) === date).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const closureFor = (roomId: number, date: string) =>
    data?.closures.find((c) => (c.roomId === null || c.roomId === roomId) && date >= c.startDate && date <= c.endDate);
  const dayLabel = (d: string) => DateTime.fromISO(d).toFormat("cccc, LLLL d, yyyy");
  const rangeLabel = days.length === 1 ? dayLabel(days[0]) : `${DateTime.fromISO(days[0]).toFormat("LLL d")} – ${DateTime.fromISO(days[days.length - 1]).toFormat("LLL d, yyyy")}`;

  const table = (items: CalendarBooking[], showRoom: boolean) => (
    <table className="print-table">
      <thead>
        <tr>
          <th style={{ width: "8.5rem" }}>Time</th>
          {showRoom && <th>Room</th>}
          <th>Booking</th>
          <th>Category</th>
          <th>Staff</th>
        </tr>
      </thead>
      <tbody>
        {items.map((b) => (
          <tr key={b.id} className={b.status}>
            <td className="mono">
              {b.allDay ? "All day" : `${fmtTime(b.startsAt, zone)}–${fmtTime(b.endsAt, zone)}`}
            </td>
            {showRoom && <td>{roomLabel(meta.rooms.find((r) => r.id === b.roomId) ?? { name: "?", code: "" })}</td>}
            <td>
              <strong>{b.title}</strong>
              {b.status === "pending" && <em> (pending approval)</em>}
              {admin && b.isPrivate && <em> (private)</em>}
              {b.description && !b.masked && <div className="print-desc">{b.description}</div>}
            </td>
            <td>{b.categoryId ? cat.get(b.categoryId) : ""}</td>
            <td>
              {b.staffName}
              {b.attendance ? <span className="muted"> · {b.attendance} ppl</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="print-page" style={brandStyle(meta.team.accentColor)}>
      <div className="print-controls no-print">
        <Link to={admin ? `/admin/teams/${id}` : `/t/${token}`} className="btn ghost small">
          ← Back
        </Link>
        <label className="field inline">
          <span>From</span>
          <input type="date" value={from} onChange={(e) => set("from", e.target.value)} />
        </label>
        <label className="field inline">
          <span>To</span>
          <input type="date" value={to} min={from} onChange={(e) => set("to", e.target.value)} />
        </label>
        <div className="btn-group">
          <button className="btn small ghost" onClick={() => { set("from", from); set("to", from); }}>1 day</button>
          <button
            className="btn small ghost"
            onClick={() => {
              const mon = DateTime.fromISO(from).startOf("week");
              const next = new URLSearchParams(params);
              next.set("from", mon.toISODate()!);
              next.set("to", mon.plus({ days: 4 }).toISODate()!);
              setParams(next, { replace: true });
            }}
          >
            Mon–Fri
          </button>
        </div>
        <label className="field inline">
          <span>Room</span>
          <select value={roomFilter} onChange={(e) => set("room", e.target.value)}>
            <option value="">All rooms</option>
            {meta.rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {roomLabel(r)}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>Group by</span>
          <select value={layout} onChange={(e) => set("layout", e.target.value)}>
            <option value="room">Room</option>
            <option value="day">Day</option>
          </select>
        </label>
        <button className="btn primary" onClick={() => window.print()}>
          Print / Save as PDF
        </button>
        {days.length === 31 && <span className="warn-text small-text">Showing the first 31 days.</span>}
      </div>

      <article className="print-sheet">
        <header className="print-head">
          {meta.team.logoDataUrl && <img src={meta.team.logoDataUrl} alt="" className="team-logo" />}
          <div>
            <h1>{meta.team.name}</h1>
            <p className="print-sub">
              Room schedule · {rangeLabel}
              {roomFilter && rooms[0] ? ` · ${roomLabel(rooms[0])}` : ""}
            </p>
          </div>
        </header>
        {!data && <p className="muted">Loading bookings…</p>}
        {data && layout === "room" &&
          rooms.map((r) => (
            <section key={r.id} className="print-section">
              <h2>
                {roomLabel(r)} <span className="print-loc">{[roomLocation(r), r.capacity ? `${r.capacity} seats` : ""].filter(Boolean).join(" · ")}</span>
              </h2>
              {days.map((d) => {
                const items = bookingsFor(r.id, d);
                const cl = closureFor(r.id, d);
                if (days.length > 1 && !items.length && !cl) return null;
                return (
                  <div key={d} className="print-day">
                    {days.length > 1 && <h3>{dayLabel(d)}</h3>}
                    {cl && <p className="print-closed">Closed{cl.reason ? `: ${cl.reason}` : ""}</p>}
                    {items.length ? table(items, false) : !cl && <p className="muted">No bookings.</p>}
                  </div>
                );
              })}
              {days.length > 1 && days.every((d) => !bookingsFor(r.id, d).length && !closureFor(r.id, d)) && <p className="muted">No bookings.</p>}
            </section>
          ))}
        {data && layout === "day" &&
          days.map((d) => {
            const items = rooms.flatMap((r) => bookingsFor(r.id, d)).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
            return (
              <section key={d} className="print-section">
                <h2>{dayLabel(d)}</h2>
                {items.length ? table(items, true) : <p className="muted">No bookings.</p>}
              </section>
            );
          })}
        <footer className="print-foot">Printed {DateTime.now().setZone(zone).toFormat("LLL d, yyyy 'at' h:mm a")} · times in {zone}</footer>
      </article>
    </div>
  );
}
