import { DateTime } from "luxon";
import type { Room, WeeklyHours } from "../../shared/types";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const WEEKDAYS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const toHm = (m: number) =>
  m >= 1440 ? "24:00" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export const fromHm = (s: string) => {
  if (s === "24:00") return 1440;
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

export function fmtMinutes(m: number): string {
  if (m >= 1440) return "midnight";
  return DateTime.fromObject({ hour: Math.floor(m / 60), minute: m % 60 }).toFormat("h:mm a");
}

export const fmtTime = (iso: string, zone: string) => DateTime.fromISO(iso).setZone(zone).toFormat("h:mm a");
export const fmtDate = (iso: string, zone: string) => DateTime.fromISO(iso).setZone(zone).toFormat("ccc, LLL d, yyyy");
export const localDate = (iso: string, zone: string) => DateTime.fromISO(iso).setZone(zone).toISODate()!;
export const localHm = (iso: string, zone: string) => DateTime.fromISO(iso).setZone(zone).toFormat("HH:mm");

export function todayIn(zone: string): string {
  return DateTime.now().setZone(zone).toISODate()!;
}

export function rangesFor(hours: WeeklyHours, date: string): [number, number][] {
  const wd = DateTime.fromISO(date).weekday;
  return (hours[String(wd)] ?? []) as [number, number][];
}

export function hoursSummary(hours: WeeklyHours): string {
  const parts: string[] = [];
  let i = 1;
  while (i <= 7) {
    const key = JSON.stringify(hours[String(i)] ?? []);
    let j = i;
    while (j < 7 && JSON.stringify(hours[String(j + 1)] ?? []) === key) j++;
    const ranges = (hours[String(i)] ?? []) as [number, number][];
    const days = i === j ? WEEKDAYS[i - 1] : `${WEEKDAYS[i - 1]}–${WEEKDAYS[j - 1]}`;
    parts.push(`${days} ${ranges.length ? ranges.map(([a, b]) => `${fmtMinutes(a)}–${fmtMinutes(b)}`).join(", ") : "closed"}`);
    i = j + 1;
  }
  return parts.join(" · ");
}

export function roomLabel(r: Pick<Room, "name" | "code">): string {
  return r.code ? `${r.name} (${r.code})` : r.name;
}

export function roomLocation(r: Pick<Room, "building" | "campus" | "floor">): string {
  return [r.building, r.floor && `Floor ${r.floor}`, r.campus].filter(Boolean).join(" · ");
}

/** Readable text colour on a background. */
export function onColor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.4 ? "#16130f" : "#ffffff";
}
