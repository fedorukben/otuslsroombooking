import type { WeeklyHours } from "../../shared/types";
import { fromHm, toHm, WEEKDAYS_LONG } from "../lib/time";

/** Weekly opening hours: each day can be closed or have several time ranges. */
export function HoursEditor({ value, onChange }: { value: WeeklyHours; onChange: (v: WeeklyHours) => void }) {
  const set = (day: number, ranges: [number, number][]) => onChange({ ...value, [String(day)]: ranges });
  const copyMonday = () => {
    const mon = value["1"] ?? [];
    onChange({ ...value, "2": [...mon], "3": [...mon], "4": [...mon], "5": [...mon] });
  };
  return (
    <div className="hours-editor">
      {WEEKDAYS_LONG.map((label, i) => {
        const day = i + 1;
        const ranges = (value[String(day)] ?? []) as [number, number][];
        return (
          <div className="hours-row" key={day}>
            <div className="hours-day">{label}</div>
            <div className="hours-ranges">
              {ranges.length === 0 && <span className="muted">Closed</span>}
              {ranges.map(([a, b], idx) => (
                <span className="hours-range" key={idx}>
                  <input
                    type="time"
                    aria-label={`${label} range ${idx + 1} opens`}
                    value={toHm(a)}
                    step={300}
                    onChange={(e) => {
                      if (!e.target.value) return;
                      const next = [...ranges];
                      next[idx] = [fromHm(e.target.value), b];
                      set(day, next);
                    }}
                  />
                  <span aria-hidden>–</span>
                  <input
                    type="time"
                    aria-label={`${label} range ${idx + 1} closes`}
                    value={b >= 1440 ? "23:59" : toHm(b)}
                    step={300}
                    onChange={(e) => {
                      if (!e.target.value) return;
                      const m = e.target.value === "23:59" ? 1440 : fromHm(e.target.value);
                      const next = [...ranges];
                      next[idx] = [a, m];
                      set(day, next);
                    }}
                  />
                  <button
                    type="button"
                    className="icon-btn small"
                    aria-label={`Remove ${label} range ${idx + 1}`}
                    onClick={() => set(day, ranges.filter((_, k) => k !== idx))}
                  >
                    ×
                  </button>
                </span>
              ))}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  const last = ranges[ranges.length - 1];
                  const start = last ? Math.min(last[1] + 60, 1380) : 510;
                  set(day, [...ranges, [start, Math.min(start + 240, 1440)]]);
                }}
              >
                + Add hours
              </button>
            </div>
          </div>
        );
      })}
      <button type="button" className="btn ghost small" onClick={copyMonday}>
        Copy Monday to Tuesday–Friday
      </button>
    </div>
  );
}
