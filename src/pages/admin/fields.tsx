import type { BookingRules, RuleOverrides } from "../../../shared/types";

const ZONES: string[] = (() => {
  try {
    return (Intl as any).supportedValuesOf("timeZone") as string[];
  } catch {
    return ["America/Toronto", "America/Vancouver", "America/Edmonton", "America/Winnipeg", "America/Halifax", "America/St_Johns", "UTC"];
  }
})();

export function TimezoneSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span>Time zone</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {(ZONES.includes(value) ? ZONES : [value, ...ZONES]).map((z) => (
          <option key={z}>{z}</option>
        ))}
      </select>
      <small className="hint">All booking times are shown in this zone, wherever people book from.</small>
    </label>
  );
}

const SLOTS = [5, 10, 15, 20, 30, 60];

/**
 * Booking rules. With `defaults`, each field may be left blank to inherit the team default (room overrides).
 */
export function RulesFields<T extends BookingRules | RuleOverrides>({
  value,
  onChange,
  defaults,
}: {
  value: T;
  onChange: (v: T) => void;
  defaults?: BookingRules;
}) {
  const inherit = !!defaults;
  const num = (k: keyof BookingRules, label: string, hint: string, min: number, max: number) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={(value[k] as number | null) ?? ""}
        placeholder={inherit ? `Team default: ${defaults![k]}` : ""}
        onChange={(e) => onChange({ ...value, [k]: e.target.value === "" ? (inherit ? null : min) : Number(e.target.value) })}
        required={!inherit}
      />
      <small className="hint">{hint}</small>
    </label>
  );
  return (
    <div className="grid-3">
      <label className="field">
        <span>Time step</span>
        <select
          value={(value.slotMinutes as number | null) ?? ""}
          onChange={(e) => onChange({ ...value, slotMinutes: e.target.value === "" ? null : Number(e.target.value) })}
        >
          {inherit && <option value="">Team default ({defaults!.slotMinutes} min)</option>}
          {SLOTS.map((s) => (
            <option key={s} value={s}>
              {s} minutes
            </option>
          ))}
        </select>
        <small className="hint">Bookings start and end on these steps.</small>
      </label>
      {num("minMinutes", "Shortest booking (min)", "Minimum length.", 5, 1440)}
      {num("maxMinutes", "Longest booking (min)", "Maximum length.", 5, 1440)}
      {num("maxDaysAhead", "Book up to (days ahead)", "How far into the future.", 1, 730)}
      {num("bufferMinutes", "Buffer between bookings (min)", "Gap kept free for turnover.", 0, 240)}
      <label className="field">
        <span>Over capacity</span>
        <select
          value={(value.capacityMode as string | null) ?? ""}
          onChange={(e) => onChange({ ...value, capacityMode: e.target.value === "" ? null : (e.target.value as "warn" | "block") })}
        >
          {inherit && <option value="">Team default ({defaults!.capacityMode === "block" ? "block" : "warn"})</option>}
          <option value="warn">Warn but allow</option>
          <option value="block">Don't allow</option>
        </select>
        <small className="hint">When attendance exceeds capacity.</small>
      </label>
    </div>
  );
}
