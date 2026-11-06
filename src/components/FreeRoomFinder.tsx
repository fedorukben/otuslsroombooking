import { useState, type FormEvent } from "react";
import type { FreeRoomResult, Recurrence, Room } from "../../shared/types";
import { api, errorText, type Endpoints } from "../api";
import { fmtDate, hoursSummary, roomLabel, roomLocation, todayIn } from "../lib/time";
import type { FormState } from "./BookingForm";
import { RecurrenceEditor } from "./RecurrenceEditor";

/** Search every room for a time (optionally repeating) and book straight from the results. */
export function FreeRoomFinder({
  zone,
  rooms,
  endpoints,
  onBook,
}: {
  zone: string;
  rooms: Room[];
  endpoints: Endpoints;
  onBook: (initial: Partial<FormState>) => void;
}) {
  const [date, setDate] = useState(todayIn(zone));
  const [startTime, setStart] = useState("10:00");
  const [endTime, setEnd] = useState("11:00");
  const [allDay, setAllDay] = useState(false);
  const [seats, setSeats] = useState("");
  const [recurrence, setRecurrence] = useState<Recurrence | null>(null);
  const [results, setResults] = useState<{ results: FreeRoomResult[]; dates: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const freeUrl = endpoints.preview.replace(/bookings\/preview$/, "free");

  async function search(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setResults(
        await api(freeUrl, {
          body: { date, startTime, endTime, allDay, minCapacity: seats ? Number(seats) : null, recurrence },
          headers: endpoints.headers,
        }),
      );
    } catch (err) {
      setError(errorText(err));
      setResults(null);
    } finally {
      setBusy(false);
    }
  }

  const available = results?.results.filter((r) => r.available) ?? [];
  const partial = results?.results.filter((r) => !r.available && r.freeCount > 0) ?? [];
  const taken = results?.results.filter((r) => r.freeCount === 0) ?? [];

  const card = (r: FreeRoomResult) => {
    const room = byId.get(r.roomId);
    if (!room) return null;
    return (
      <li key={r.roomId} className={`free-card ${r.available ? "ok" : r.freeCount ? "part" : "no"}`} style={{ ["--room" as string]: room.color }}>
        <div className="free-main">
          <h3>{roomLabel(room)}</h3>
          <p className="loc">
            {roomLocation(room) || "—"}
            {room.capacity ? ` · ${room.capacity} seats` : ""}
            {room.requiresApproval ? " · needs approval" : ""}
          </p>
          {room.description && <p className="desc">{room.description}</p>}
          {!r.available && (
            <ul className="reasons">
              {r.reasons.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
          <p className="hours small-text">{hoursSummary(room.hours)}</p>
        </div>
        <div className="free-side">
          <span className={`free-badge ${r.available ? "ok" : r.freeCount ? "part" : "no"}`}>
            {r.available ? "Free" : r.freeCount ? `${r.freeCount} of ${r.total} free` : "Not available"}
          </span>
          {r.freeCount > 0 && (
            <button
              className="btn primary small"
              onClick={() => onBook({ roomId: room.id, date, startTime, endTime, allDay, recurrence, attendance: seats })}
            >
              Book this room
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <section className="finder">
      <form className="card finder-form" onSubmit={search}>
        <h2>Find a free room</h2>
        <div className="grid-4">
          <label className="field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          {!allDay && (
            <>
              <label className="field">
                <span>From</span>
                <input type="time" value={startTime} onChange={(e) => setStart(e.target.value)} required />
              </label>
              <label className="field">
                <span>To</span>
                <input type="time" value={endTime} onChange={(e) => setEnd(e.target.value)} required />
              </label>
            </>
          )}
          <label className="field">
            <span>
              Seats needed <em className="opt">optional</em>
            </span>
            <input type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day
        </label>
        {date && <RecurrenceEditor value={recurrence} onChange={setRecurrence} startDate={date} />}
        <div className="actions">
          <button className="btn primary" disabled={busy}>
            {busy ? "Searching…" : "Search rooms"}
          </button>
        </div>
      </form>
      {error && <p className="error">{error}</p>}
      {results && (
        <div className="finder-results" aria-live="polite">
          <p className="muted">
            {available.length} {available.length === 1 ? "room is" : "rooms are"} free on {fmtDate(`${date}T12:00:00`, zone)}
            {results.dates > 1 ? ` for all ${results.dates} dates` : ""}.
          </p>
          <ul className="free-list">{available.map(card)}</ul>
          {partial.length > 0 && (
            <>
              <h3 className="free-heading">Free on some of the dates</h3>
              <ul className="free-list">{partial.map(card)}</ul>
            </>
          )}
          {taken.length > 0 && (
            <details>
              <summary>Not available ({taken.length})</summary>
              <ul className="free-list">{taken.map(card)}</ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
