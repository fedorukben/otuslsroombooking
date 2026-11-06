import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { BookingStatus, Category, CreateResult, EditScope, PreviewResult, PublicTeam, Recurrence, Room } from "../../shared/types";
import { api, ApiError, errorText, type Endpoints } from "../api";
import { me } from "../lib/storage";
import { fmtDate, fmtMinutes, fmtTime, rangesFor, roomLabel, roomLocation } from "../lib/time";
import { RecurrenceEditor } from "./RecurrenceEditor";

export interface FormState {
  roomId: number;
  categoryId: number;
  title: string;
  staffName: string;
  staffEmail: string;
  attendance: string;
  description: string;
  isPrivate: boolean;
  allDay: boolean;
  date: string;
  startTime: string;
  endTime: string;
  recurrence: Recurrence | null;
  override: boolean;
  scope: EditScope;
}

export interface EditTarget {
  manageBase: string;
  bookingId: number;
  seriesRecurring: boolean;
  headers: Record<string, string>;
}

export type FormResult =
  | { kind: "created"; result: CreateResult; state: FormState }
  | { kind: "updated"; updated: number; status: BookingStatus };

export function BookingForm({
  team,
  rooms,
  categories,
  admin,
  initial,
  endpoints,
  edit,
  onDone,
  onCancel,
  people = [],
  self,
}: {
  people?: string[];
  /** Signed-in staff: they always book as themselves. */
  self?: { name: string; email: string };
  team: PublicTeam;
  rooms: Room[];
  categories: Category[];
  admin: boolean;
  initial: Partial<FormState>;
  endpoints?: Endpoints;
  edit?: EditTarget;
  onDone: (r: FormResult) => void;
  onCancel: () => void;
}) {
  const remembered = me.get();
  const [s, setS] = useState<FormState>(() => ({
    roomId: rooms[0]?.id ?? 0,
    categoryId: 0,
    title: "",
    staffName: self ? self.name : admin ? "" : remembered.name,
    staffEmail: self ? self.email : admin ? "" : remembered.email,
    attendance: "",
    description: "",
    isPrivate: false,
    allDay: false,
    date: "",
    startTime: "09:00",
    endTime: "10:00",
    recurrence: null,
    override: false,
    scope: edit?.seriesRecurring ? "this" : "all",
    ...initial,
  }));
  const listed = people.length > 0;
  const allowOther = admin || !team.peopleOnly;
  const inList = (n: string) => people.find((p) => p.toLowerCase() === n.trim().toLowerCase());
  const [otherName, setOtherName] = useState(() => listed && allowOther && !!s.staffName && !inList(s.staffName));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState<PreviewResult | null>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (review) reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [review]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setS((prev) => ({ ...prev, [k]: v }));
    setReview(null);
    setError("");
  };

  const room = rooms.find((r) => r.id === s.roomId);
  const allowedCats = useMemo(
    () => categories.filter((c) => (c.active || c.id === s.categoryId) && (!room?.allowedCategoryIds.length || room.allowedCategoryIds.includes(c.id))),
    [categories, room, s.categoryId],
  );
  const rules = room?.rules ?? team.rules;
  const req = team.requiredFields;
  const dayRanges = room && s.date ? rangesFor(room.hours, s.date) : [];
  const showRepeat = !edit || s.scope !== "this";

  function payload(skipDates: string[] = []) {
    return {
      roomId: s.roomId,
      categoryId: s.categoryId,
      title: s.title,
      staffName: s.staffName,
      staffEmail: s.staffEmail,
      attendance: s.attendance ? Number(s.attendance) : null,
      description: s.description,
      isPrivate: s.isPrivate,
      allDay: s.allDay,
      date: s.date,
      startTime: s.startTime,
      endTime: s.endTime,
      recurrence: showRepeat ? s.recurrence : null,
      override: admin && s.override,
      website: (document.getElementById("rs-website") as HTMLInputElement | null)?.value ?? "",
      skipDates,
      ...(edit ? { scope: s.scope } : {}),
    };
  }

  const headers = edit?.headers ?? endpoints?.headers ?? {};
  const previewUrl = edit ? `${edit.manageBase}/bookings/${edit.bookingId}/preview` : endpoints!.preview;

  async function commit(skipDates: string[]) {
    setBusy(true);
    setError("");
    try {
      if (!admin && !self) me.set({ name: s.staffName, email: s.staffEmail });
      if (edit) {
        const r = await api<{ updated: number; status: BookingStatus }>(`${edit.manageBase}/bookings/${edit.bookingId}`, {
          method: "PATCH",
          body: payload(skipDates),
          headers,
        });
        onDone({ kind: "updated", ...r });
      } else {
        const r = await api<CreateResult>(endpoints!.create, { body: payload(skipDates), headers });
        onDone({ kind: "created", result: r, state: s });
      }
    } catch (err) {
      if (err instanceof ApiError && err.data?.preview) setReview(err.data.preview);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!s.categoryId) return setError("Choose a category.");
    setBusy(true);
    setError("");
    try {
      const p = await api<PreviewResult>(previewUrl, { body: payload(), headers });
      const hasProblems = p.occurrences.some((o) => o.issues.length) || p.truncated;
      if (!hasProblems) {
        setBusy(false);
        return commit([]);
      }
      setReview(p);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const blockedDates = review?.occurrences.filter((o) => o.issues.some((i) => i.severity === "block")).map((o) => o.date) ?? [];

  return (
    <form className="booking-form" onSubmit={submit} noValidate>
      {edit?.seriesRecurring && (
        <fieldset className="scope">
          <legend>Change which bookings?</legend>
          {(
            [
              ["this", "Only this one"],
              ["following", "This and following"],
              ["all", "All upcoming in the series"],
            ] as [EditScope, string][]
          ).map(([v, label]) => (
            <label className="radio" key={v}>
              <input type="radio" name="scope" checked={s.scope === v} onChange={() => set("scope", v)} />
              {label}
            </label>
          ))}
          {s.scope !== "this" && <p className="hint">Changed occurrences are regenerated from the date and repeat pattern below. Past ones stay as they were.</p>}
        </fieldset>
      )}

      <div className="grid-2">
        <label className="field">
          <span>Room</span>
          <select value={s.roomId} onChange={(e) => set("roomId", Number(e.target.value))} required>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {roomLabel(r)}
                {r.building ? ` — ${r.building}` : ""}
                {r.active ? "" : " (inactive)"}
              </option>
            ))}
          </select>
          {room && (
            <small className="hint">
              {roomLocation(room) || " "}
              {room.capacity ? ` · seats ${room.capacity}` : ""}
              {room.requiresApproval ? " · needs approval" : ""}
            </small>
          )}
        </label>
        <label className="field">
          <span>Category</span>
          <select value={s.categoryId || ""} onChange={(e) => set("categoryId", Number(e.target.value))} required>
            <option value="" disabled>
              Choose…
            </option>
            {allowedCats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field">
        <span>Event title</span>
        <input value={s.title} onChange={(e) => set("title", e.target.value)} maxLength={150} required />
      </label>

      <div className="grid-3">
        <label className="field">
          <span>Date</span>
          <input type="date" value={s.date} onChange={(e) => set("date", e.target.value)} required />
        </label>
        {!s.allDay && (
          <>
            <label className="field">
              <span>Start</span>
              <input type="time" step={rules.slotMinutes * 60} value={s.startTime} onChange={(e) => set("startTime", e.target.value)} required />
            </label>
            <label className="field">
              <span>End</span>
              <input type="time" step={rules.slotMinutes * 60} value={s.endTime} onChange={(e) => set("endTime", e.target.value)} required />
            </label>
          </>
        )}
      </div>
      <div className="row wrap">
        <label className="check">
          <input type="checkbox" checked={s.allDay} onChange={(e) => set("allDay", e.target.checked)} />
          All day (the room's open hours)
        </label>
        {room && s.date && (
          <small className="hint">
            Open {dayRanges.length ? dayRanges.map(([a, b]) => `${fmtMinutes(a)}–${fmtMinutes(b)}`).join(", ") : "— closed this day"} · {rules.slotMinutes}-min steps ·{" "}
            {rules.minMinutes}–{rules.maxMinutes} min
          </small>
        )}
      </div>

      {showRepeat && s.date && <RecurrenceEditor value={s.recurrence} onChange={(v) => set("recurrence", v)} startDate={s.date} />}

      {self ? (
        <div className="booking-as">
          Booking as <strong>{self.name}</strong>
          {self.email ? <span className="muted"> · {self.email}</span> : null}
        </div>
      ) : (
      <div className="grid-2">
        {listed && !otherName ? (
          <label className="field">
            <span>Staff member</span>
            <select
              value={inList(s.staffName) ?? ""}
              onChange={(e) => {
                if (e.target.value === "__other") {
                  setOtherName(true);
                  set("staffName", "");
                } else set("staffName", e.target.value);
              }}
              required
            >
              <option value="" disabled>
                Choose a name…
              </option>
              {people.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
              {allowOther && <option value="__other">Someone else…</option>}
            </select>
            {!allowOther && <small className="hint">Not on the list? Ask a team admin to add you.</small>}
          </label>
        ) : (
          <label className="field">
            <span>Staff member name</span>
            <input value={s.staffName} onChange={(e) => set("staffName", e.target.value)} autoComplete="name" required maxLength={120} />
            {listed && (
              <button type="button" className="link-btn left" onClick={() => { setOtherName(false); set("staffName", ""); }}>
                Pick from the list instead
              </button>
            )}
          </label>
        )}
        <label className="field">
          <span>
            Email {req.email ? "" : <em className="opt">optional</em>}
          </span>
          <input type="email" value={s.staffEmail} onChange={(e) => set("staffEmail", e.target.value)} autoComplete="email" required={req.email && !inList(s.staffName)} />
          {listed && inList(s.staffName) && !s.staffEmail && <small className="hint">Leave blank to use the email on file.</small>}
        </label>
      </div>
      )}

      <div className="grid-2">
        <label className="field">
          <span>
            Expected attendance {req.attendance ? "" : <em className="opt">optional</em>}
          </span>
          <input type="number" min={1} value={s.attendance} onChange={(e) => set("attendance", e.target.value)} required={req.attendance} />
          {room?.capacity && Number(s.attendance) > room.capacity && (
            <small className="warn-text">
              Over this room's capacity of {room.capacity}
              {rules.capacityMode === "block" ? " — not allowed" : ""}.
            </small>
          )}
        </label>
        <div className="field">
          <span>Visibility</span>
          <label className="switch">
            <input type="checkbox" checked={s.isPrivate} onChange={(e) => set("isPrivate", e.target.checked)} />
            <span>{s.isPrivate ? "Private — others see “Busy”" : "Public — others see the title"}</span>
          </label>
          <small className="hint">Admins always see full details.</small>
        </div>
      </div>

      <label className="field">
        <span>
          Description {req.description ? "" : <em className="opt">optional</em>}
        </span>
        <textarea rows={3} value={s.description} onChange={(e) => set("description", e.target.value)} maxLength={2000} required={req.description} />
      </label>

      {/* Honeypot for bots: hidden from people and screen readers. */}
      <div className="hp" aria-hidden="true">
        <label>
          Website <input id="rs-website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      {admin && (
        <label className="check override">
          <input type="checkbox" checked={s.override} onChange={(e) => set("override", e.target.checked)} />
          Override booking rules (hours, closures, limits). Overlapping bookings are still not allowed.
        </label>
      )}

      {review && (
        <div className="review" role="status" ref={reviewRef}>
          <h3>Check before booking</h3>
          {review.truncated && <p className="warn-text">Long repeats are capped at 366 occurrences or two years.</p>}
          {review.willBePending && <p className="hint">This room needs approval. Your booking will hold the time as “Pending” until an admin approves it.</p>}
          <ul className="occ-list">
            {review.occurrences
              .filter((o) => o.issues.length)
              .map((o) => (
                <li key={o.date} className={o.issues.some((i) => i.severity === "block") ? "blocked" : "warned"}>
                  <strong>
                    {fmtDate(o.startsAt, team.timezone)} {fmtTime(o.startsAt, team.timezone)}
                  </strong>
                  <ul>
                    {o.issues.map((i, k) => (
                      <li key={k}>
                        <span className="tag">{i.severity === "block" ? "Can't book" : "Note"}</span> {i.message}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
          </ul>
          <p>
            {review.bookable} of {review.occurrences.length} {review.occurrences.length === 1 ? "date" : "dates"} can be booked.
          </p>
        </div>
      )}

      {error && !review && (
        <p className="error" role="alert" ref={(el) => el?.scrollIntoView({ behavior: "smooth", block: "nearest" })}>
          {error}
        </p>
      )}

      <div className="actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        {review ? (
          <>
            <button type="button" className="btn ghost" onClick={() => setReview(null)}>
              Back to edit
            </button>
            {review.bookable > 0 && (
              <button type="button" className="btn primary" disabled={busy} onClick={() => commit(blockedDates)}>
                {blockedDates.length
                  ? `Book ${review.bookable} ${review.bookable === 1 ? "date" : "dates"}, skip ${blockedDates.length}`
                  : edit
                    ? "Save anyway"
                    : "Book anyway"}
              </button>
            )}
          </>
        ) : (
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "Checking…" : edit ? "Save changes" : "Book room"}
          </button>
        )}
      </div>
    </form>
  );
}
