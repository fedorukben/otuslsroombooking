import { DateTime } from "luxon";
import { useEffect, useMemo, useState } from "react";
import type { CalendarBooking, Category, Closure, Room } from "../../shared/types";
import { api, errorText, type Endpoints } from "../api";
import { fmtMinutes, fmtTime, localHm, fromHm, onColor, rangesFor } from "../lib/time";

const PX_PER_MIN = 1.1;

/** One day, every (filtered) room side by side. Click an open slot to book it. */
export function DayGrid({
  zone,
  rooms,
  categories,
  endpoints,
  date,
  onDateChange,
  refreshKey,
  onSlot,
  onOpen,
}: {
  zone: string;
  rooms: Room[];
  categories: Category[];
  endpoints: Endpoints;
  date: string;
  onDateChange: (d: string) => void;
  refreshKey: number;
  onSlot: (room: Room, date: string, startMin: number, endMin: number) => void;
  onOpen: (b: CalendarBooking) => void;
}) {
  const [bookings, setBookings] = useState<CalendarBooking[]>([]);
  const [closures, setClosures] = useState<Closure[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const start = DateTime.fromISO(date, { zone }).startOf("day");
    const end = start.plus({ days: 1 });
    let alive = true;
    setLoading(true);
    api<{ bookings: CalendarBooking[]; closures: Closure[] }>(
      `${endpoints.events}?start=${encodeURIComponent(start.toUTC().toISO()!)}&end=${encodeURIComponent(end.toUTC().toISO()!)}`,
      { headers: endpoints.headers },
    )
      .then((r) => {
        if (!alive) return;
        setBookings(r.bookings);
        setClosures(r.closures);
        setError("");
      })
      .catch((e) => alive && setError(errorText(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [date, zone, endpoints.events, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const catColor = useMemo(() => new Map(categories.map((c) => [c.id, c.color])), [categories]);
  const catName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);

  const allRanges = rooms.flatMap((r) => rangesFor(r.hours, date));
  const bookedMins = bookings.flatMap((b) => [fromHm(localHm(b.startsAt, zone)), fromHm(localHm(b.endsAt, zone)) || 1440]);
  const minMin = Math.floor(Math.min(...(allRanges.length ? allRanges.map((r) => r[0]) : [480]), ...bookedMins, 1440) / 60) * 60;
  const maxMin = Math.ceil(Math.max(...(allRanges.length ? allRanges.map((r) => r[1]) : [1080]), ...bookedMins, 0) / 60) * 60;
  const lo = Math.min(minMin, 480);
  const hi = Math.max(maxMin, lo + 600);
  const height = (hi - lo) * PX_PER_MIN;
  const hoursMarks: number[] = [];
  for (let m = lo; m <= hi; m += 60) hoursMarks.push(m);

  const now = DateTime.now().setZone(zone);
  const isToday = now.toISODate() === date;
  const nowMin = now.hour * 60 + now.minute;
  const day = DateTime.fromISO(date);

  return (
    <section className="daygrid-wrap" aria-label="All rooms, one day">
      <div className="daygrid-toolbar">
        <div className="btn-group">
          <button className="btn ghost small" onClick={() => onDateChange(day.minus({ days: 1 }).toISODate()!)} aria-label="Previous day">
            ←
          </button>
          <button className="btn ghost small" onClick={() => onDateChange(now.toISODate()!)}>
            Today
          </button>
          <button className="btn ghost small" onClick={() => onDateChange(day.plus({ days: 1 }).toISODate()!)} aria-label="Next day">
            →
          </button>
        </div>
        <h2 className="daygrid-title">{day.toFormat("cccc, LLLL d")}</h2>
        <input type="date" aria-label="Go to date" value={date} onChange={(e) => e.target.value && onDateChange(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      {!rooms.length ? (
        <p className="empty">No rooms match your filters.</p>
      ) : (
        <div className={`daygrid ${loading ? "is-loading" : ""}`} style={{ ["--cols" as string]: rooms.length }}>
          <div className="dg-corner" />
          {rooms.map((r) => (
            <div className="dg-head" key={r.id}>
              <span className="dot" style={{ background: r.color }} />
              <span className="dg-room">{r.name}</span>
              <span className="dg-meta">
                {[r.code, r.capacity ? `${r.capacity} seats` : ""].filter(Boolean).join(" · ")}
              </span>
            </div>
          ))}
          <div className="dg-gutter" style={{ height }}>
            {hoursMarks.map((m) => (
              <span key={m} style={{ top: (m - lo) * PX_PER_MIN }}>
                {fmtMinutes(m).replace(":00", "")}
              </span>
            ))}
          </div>
          {rooms.map((r) => {
            const ranges = rangesFor(r.hours, date);
            const closure = closures.find((c) => (c.roomId === null || c.roomId === r.id) && date >= c.startDate && date <= c.endDate);
            const step = r.rules.slotMinutes;
            const slots: number[] = [];
            if (!closure) for (const [a, b] of ranges) for (let m = a; m + step <= b; m += step) slots.push(m);
            const roomBookings = bookings.filter((b) => b.roomId === r.id);
            return (
              <div className="dg-col" key={r.id} style={{ height }}>
                {hoursMarks.map((m) => (
                  <div key={m} className="dg-line" style={{ top: (m - lo) * PX_PER_MIN }} />
                ))}
                {/* shade closed time */}
                {closure ? (
                  <div className="dg-closed full" style={{ top: 0, height }}>
                    <span>Closed{closure.reason ? `: ${closure.reason}` : ""}</span>
                  </div>
                ) : (
                  invert(ranges, lo, hi).map(([a, b]) => (
                    <div key={a} className="dg-closed" style={{ top: (a - lo) * PX_PER_MIN, height: (b - a) * PX_PER_MIN }} />
                  ))
                )}
                {slots.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="dg-slot"
                    style={{ top: (m - lo) * PX_PER_MIN, height: step * PX_PER_MIN }}
                    aria-label={`Book ${r.name} at ${fmtMinutes(m)}`}
                    onClick={() => onSlot(r, date, m, Math.min(m + Math.max(60, r.rules.minMinutes), ranges.find(([a, b]) => m >= a && m < b)?.[1] ?? m + 60))}
                  />
                ))}
                {roomBookings.map((b) => {
                  const s = fromHm(localHm(b.startsAt, zone));
                  const e = fromHm(localHm(b.endsAt, zone)) || 1440;
                  const bg = b.categoryId ? catColor.get(b.categoryId) ?? "#6e7781" : "#9a948a";
                  return (
                    <button
                      key={b.id}
                      type="button"
                      className={`dg-booking ${b.status} ${b.masked ? "masked" : ""}`}
                      style={{ top: (s - lo) * PX_PER_MIN, height: Math.max((e - s) * PX_PER_MIN - 2, 18), background: bg, color: onColor(bg) }}
                      onClick={() => onOpen(b)}
                      aria-label={`${b.title}, ${fmtTime(b.startsAt, zone)} to ${fmtTime(b.endsAt, zone)}${b.status === "pending" ? ", pending approval" : ""}`}
                    >
                      <span className="b-time">
                        {fmtTime(b.startsAt, zone)}
                        {b.status === "pending" ? " · Pending" : ""}
                      </span>
                      <span className="b-title">{b.title}</span>
                      {!b.masked && (e - s) >= 60 && (
                        <span className="b-sub">
                          {b.staffName}
                          {b.categoryId ? ` · ${catName.get(b.categoryId) ?? ""}` : ""}
                          {b.isPrivate ? " · Private" : ""}
                        </span>
                      )}
                    </button>
                  );
                })}
                {isToday && nowMin >= lo && nowMin <= hi && <div className="dg-now" style={{ top: (nowMin - lo) * PX_PER_MIN }} />}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Gaps between open ranges within [lo, hi]. */
function invert(ranges: [number, number][], lo: number, hi: number): [number, number][] {
  const out: [number, number][] = [];
  let cur = lo;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a > cur) out.push([cur, Math.min(a, hi)]);
    cur = Math.max(cur, b);
  }
  if (cur < hi) out.push([cur, hi]);
  return out.filter(([a, b]) => b > a);
}
