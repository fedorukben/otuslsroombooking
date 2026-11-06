import { DateTime } from "luxon";
import type { Recurrence } from "../shared/types.js";
import { bad, isoDate } from "./http.js";

export const MAX_OCCURRENCES = 366;
const MAX_SPAN_DAYS = 2 * 366;

/** Validates and normalizes a recurrence object from a request. */
export function parseRecurrence(raw: unknown, startDate: string): Recurrence | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") throw bad("Recurrence is malformed.");
  const r = raw as Record<string, any>;
  if (!["daily", "weekly", "monthly"].includes(r.freq)) throw bad("Repeat must be daily, weekly or monthly.");
  const interval = Number(r.interval ?? 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) throw bad("Repeat interval must be between 1 and 52.");
  const out: Recurrence = { freq: r.freq, interval, end: { type: "count", count: 1 } };
  if (r.freq === "weekly") {
    const days = Array.isArray(r.byWeekday) ? r.byWeekday.map(Number) : [];
    const clean = [...new Set(days.filter((d: number) => Number.isInteger(d) && d >= 1 && d <= 7))].sort() as number[];
    if (!clean.length) clean.push(DateTime.fromISO(startDate).weekday);
    out.byWeekday = clean;
  }
  if (r.freq === "monthly") out.monthlyMode = r.monthlyMode === "weekday" ? "weekday" : "date";
  const end = r.end ?? {};
  if (end.type === "until") {
    const date = isoDate(end.date, "Repeat-until date");
    if (date < startDate) throw bad("The repeat-until date is before the first booking.");
    out.end = { type: "until", date };
  } else if (end.type === "count") {
    const count = Number(end.count);
    if (!Number.isInteger(count) || count < 1) throw bad("Number of occurrences must be at least 1.");
    out.end = { type: "count", count };
  } else {
    throw bad("Choose when the repeat ends.");
  }
  return out;
}

/** Expands a recurrence into local calendar dates (YYYY-MM-DD). Date math only; times are applied later. */
export function expandDates(startDate: string, rec: Recurrence | null): { dates: string[]; truncated: boolean } {
  if (!rec) return { dates: [startDate], truncated: false };
  const start = DateTime.fromISO(startDate, { zone: "utc" });
  const spanLimit = start.plus({ days: MAX_SPAN_DAYS });
  let limit = spanLimit;
  let truncated = false;
  if (rec.end.type === "until") {
    const until = DateTime.fromISO(rec.end.date, { zone: "utc" });
    if (until > spanLimit) truncated = true;
    else limit = until;
  }
  let maxCount = MAX_OCCURRENCES;
  if (rec.end.type === "count") {
    if (rec.end.count > MAX_OCCURRENCES) truncated = true;
    else maxCount = rec.end.count;
  }

  const out: string[] = [];
  const push = (d: DateTime) => {
    out.push(d.toISODate()!);
    return out.length >= maxCount;
  };
  const step = rec.interval;

  if (rec.freq === "daily") {
    for (let d = start; d <= limit; d = d.plus({ days: step })) if (push(d)) break;
  } else if (rec.freq === "weekly") {
    const days = rec.byWeekday?.length ? rec.byWeekday : [start.weekday];
    const monday = start.minus({ days: start.weekday - 1 });
    outer: for (let w = 0; ; w += step) {
      const base = monday.plus({ weeks: w });
      if (base > limit) break;
      for (const wd of days) {
        const d = base.plus({ days: wd - 1 });
        if (d < start) continue;
        if (d > limit) break outer;
        if (push(d)) break outer;
      }
    }
  } else {
    const nth = Math.ceil(start.day / 7); // 1..5; 5 means "last"
    for (let k = 0; ; k += step) {
      const month = start.startOf("month").plus({ months: k });
      if (month > limit) break;
      let day: number;
      if (rec.monthlyMode === "weekday") {
        if (nth === 5) {
          const last = month.endOf("month").startOf("day");
          day = last.day - ((last.weekday - start.weekday + 7) % 7);
        } else {
          day = 1 + ((start.weekday - month.weekday + 7) % 7) + (nth - 1) * 7;
          if (day > month.daysInMonth!) continue;
        }
      } else {
        if (start.day > month.daysInMonth!) continue; // e.g. the 31st in a 30-day month
        day = start.day;
      }
      const d = month.set({ day });
      if (d < start) continue;
      if (d > limit) break;
      if (push(d)) break;
    }
  }
  if (out.length >= MAX_OCCURRENCES && rec.end.type === "until" && !truncated) {
    truncated = DateTime.fromISO(out[out.length - 1], { zone: "utc" }) < limit;
  }
  return { dates: out, truncated };
}
