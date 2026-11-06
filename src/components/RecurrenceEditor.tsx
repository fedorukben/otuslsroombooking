import { DateTime } from "luxon";
import type { Recurrence } from "../../shared/types";
import { describeRecurrence } from "../../shared/recurrence";
import { WEEKDAYS, WEEKDAYS_LONG } from "../lib/time";

const ORD = ["first", "second", "third", "fourth", "last"];

export function RecurrenceEditor({
  value,
  onChange,
  startDate,
}: {
  value: Recurrence | null;
  onChange: (v: Recurrence | null) => void;
  startDate: string;
}) {
  const start = DateTime.fromISO(startDate);
  const freq = value?.freq ?? "none";

  const setFreq = (f: string) => {
    if (f === "none") return onChange(null);
    onChange({
      freq: f as Recurrence["freq"],
      interval: value?.interval ?? 1,
      byWeekday: f === "weekly" ? value?.byWeekday ?? [start.weekday] : undefined,
      monthlyMode: f === "monthly" ? value?.monthlyMode ?? "date" : undefined,
      end: value?.end ?? { type: "until", date: start.plus({ months: 3 }).toISODate()! },
    });
  };

  return (
    <fieldset className="recurrence">
      <legend>Repeat</legend>
      <div className="row wrap">
        <label className="field inline">
          <span className="sr-only">Repeat frequency</span>
          <select value={freq} onChange={(e) => setFreq(e.target.value)}>
            <option value="none">Does not repeat</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        {value && (
          <label className="field inline">
            <span>every</span>
            <input
              type="number"
              min={1}
              max={52}
              value={value.interval}
              onChange={(e) => onChange({ ...value, interval: Math.max(1, Number(e.target.value) || 1) })}
              style={{ width: "4.5rem" }}
            />
            <span>{{ daily: "day(s)", weekly: "week(s)", monthly: "month(s)" }[value.freq]}</span>
          </label>
        )}
      </div>

      {value?.freq === "weekly" && (
        <div className="weekday-picker" role="group" aria-label="Repeat on">
          {WEEKDAYS.map((d, i) => {
            const wd = i + 1;
            const on = value.byWeekday?.includes(wd) ?? false;
            return (
              <button
                type="button"
                key={d}
                className={`chip ${on ? "on" : ""}`}
                aria-pressed={on}
                aria-label={WEEKDAYS_LONG[i]}
                onClick={() => {
                  const set = new Set(value.byWeekday ?? []);
                  if (on) set.delete(wd);
                  else set.add(wd);
                  onChange({ ...value, byWeekday: [...set].sort() });
                }}
              >
                {d.slice(0, 2)}
              </button>
            );
          })}
        </div>
      )}

      {value?.freq === "monthly" && (
        <div className="row wrap">
          <label className="radio">
            <input type="radio" checked={value.monthlyMode !== "weekday"} onChange={() => onChange({ ...value, monthlyMode: "date" })} />
            On day {start.day}
          </label>
          <label className="radio">
            <input type="radio" checked={value.monthlyMode === "weekday"} onChange={() => onChange({ ...value, monthlyMode: "weekday" })} />
            On the {ORD[Math.ceil(start.day / 7) - 1]} {WEEKDAYS_LONG[start.weekday - 1]}
          </label>
        </div>
      )}

      {value && (
        <div className="row wrap">
          <label className="radio">
            <input
              type="radio"
              checked={value.end.type === "until"}
              onChange={() => onChange({ ...value, end: { type: "until", date: start.plus({ months: 3 }).toISODate()! } })}
            />
            Until
          </label>
          {value.end.type === "until" && (
            <input
              type="date"
              aria-label="Repeat until"
              value={value.end.date}
              min={startDate}
              onChange={(e) => onChange({ ...value, end: { type: "until", date: e.target.value } })}
            />
          )}
          <label className="radio">
            <input type="radio" checked={value.end.type === "count"} onChange={() => onChange({ ...value, end: { type: "count", count: 10 } })} />
            After
          </label>
          {value.end.type === "count" && (
            <label className="field inline">
              <input
                type="number"
                min={1}
                max={366}
                aria-label="Number of occurrences"
                value={value.end.count}
                onChange={(e) => onChange({ ...value, end: { type: "count", count: Math.max(1, Number(e.target.value) || 1) } })}
                style={{ width: "5rem" }}
              />
              <span>times</span>
            </label>
          )}
        </div>
      )}
      {value && <p className="hint">{describeRecurrence(value, startDate)}</p>}
    </fieldset>
  );
}
