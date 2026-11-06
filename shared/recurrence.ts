import { DateTime } from "luxon";
import type { Recurrence } from "./types.js";

const ORD = ["first", "second", "third", "fourth", "last"];
const WD = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Human summary, e.g. "Every 2 weeks on Monday, Wednesday until 2027-04-30". */
export function describeRecurrence(rec: Recurrence, startDate: string): string {
  const s = DateTime.fromISO(startDate);
  const unit = { daily: "day", weekly: "week", monthly: "month" }[rec.freq];
  let text = rec.interval === 1 ? `Every ${unit}` : `Every ${rec.interval} ${unit}s`;
  if (rec.freq === "weekly") text += ` on ${(rec.byWeekday ?? [s.weekday]).map((d) => WD[d]).join(", ")}`;
  if (rec.freq === "monthly") {
    text += rec.monthlyMode === "weekday" ? ` on the ${ORD[Math.ceil(s.day / 7) - 1]} ${WD[s.weekday]}` : ` on day ${s.day}`;
  }
  text += rec.end.type === "until" ? ` until ${rec.end.date}` : `, ${rec.end.count} times`;
  return text;
}
