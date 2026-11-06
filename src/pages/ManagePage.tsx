import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { EditScope, ManagedBooking, ManageView } from "../../shared/types";
import { describeRecurrence } from "../../shared/recurrence";
import { api, errorText } from "../api";
import { BookingForm } from "../components/BookingForm";
import { Modal } from "../components/Modal";
import { CopyLink } from "../components/Scheduler";
import { savedBookings } from "../lib/storage";
import { fmtDate, fmtTime, localDate, localHm, roomLabel } from "../lib/time";
import { brandStyle, TeamHeader } from "./TeamPage";

/** Edit or cancel a booking (or series). Members reach it through their private link; admins from the calendar. */
export function ManagePage({ admin = false }: { admin?: boolean }) {
  const { token = "" } = useParams();
  const base = admin ? `/admin/manage/${token}` : `/manage/${token}`;
  const [view, setView] = useState<ManageView | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ManagedBooking | null>(null);
  const [cancelling, setCancelling] = useState<ManagedBooking | null>(null);
  const [scope, setScope] = useState<EditScope>("this");
  const [notice, setNotice] = useState("");
  const [showPast, setShowPast] = useState(false);

  const load = useCallback(() => {
    api<ManageView>(base)
      .then((v) => {
        setView(v);
        setError("");
      })
      .catch((e) => setError(errorText(e)));
  }, [base]);
  useEffect(load, [load]);

  if (error) {
    return (
      <main className="center-page">
        <div className="card narrow">
          <h1>Booking not found</h1>
          <p>{error}</p>
        </div>
      </main>
    );
  }
  if (!view) return <main className="center-page"><p className="muted">Loading…</p></main>;

  const zone = view.team.timezone;
  const rooms = new Map(view.rooms.map((r) => [r.id, r]));
  const cats = new Map(view.categories.map((c) => [c.id, c]));
  const now = Date.now();
  const upcoming = view.bookings.filter((b) => b.status !== "cancelled" && new Date(b.endsAt).getTime() > now);
  const past = view.bookings.filter((b) => b.status !== "cancelled" && new Date(b.endsAt).getTime() <= now);
  const cancelled = view.bookings.filter((b) => b.status === "cancelled");
  const recurring = !!view.recurrence;
  const first = view.bookings[0];
  const headline = upcoming[0] ?? first;

  async function doCancel() {
    if (!cancelling) return;
    try {
      const r = await api<{ cancelled: number }>(`${base}/bookings/${cancelling.id}/cancel`, { body: { scope: recurring ? scope : "this" } });
      setNotice(`Cancelled ${r.cancelled} ${r.cancelled === 1 ? "booking" : "bookings"}.`);
      setCancelling(null);
      load();
    } catch (e) {
      setNotice(errorText(e));
    }
  }

  const row = (b: ManagedBooking) => {
    const r = rooms.get(b.roomId);
    return (
      <li key={b.id} className={`occ ${b.status}`}>
        <div>
          <strong>{fmtDate(b.startsAt, zone)}</strong>
          <span>
            {b.allDay ? "All day" : `${fmtTime(b.startsAt, zone)} – ${fmtTime(b.endsAt, zone)}`} · {r ? roomLabel(r) : "Room removed"}
          </span>
          <span className="muted">
            {b.title} · {b.categoryId ? cats.get(b.categoryId)?.name : ""}
            {b.isException ? " · changed" : ""}
          </span>
        </div>
        <div className="occ-status">
          {b.status === "pending" && <span className="badge amber">Pending</span>}
          {b.status === "cancelled" && <span className="badge">Cancelled</span>}
          {b.status !== "cancelled" && new Date(b.endsAt).getTime() > now && (
            <>
              <button className="btn small" onClick={() => setEditing(b)}>
                Edit
              </button>
              <button className="btn small ghost danger" onClick={() => { setScope("this"); setCancelling(b); }}>
                Cancel
              </button>
            </>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="member-shell" style={brandStyle(view.team.accentColor)}>
      <TeamHeader name={view.team.name} logo={view.team.logoDataUrl}>
        {admin && view.teamId && (
          <Link className="btn ghost" to={`/admin/teams/${view.teamId}`}>
            ← Back to team
          </Link>
        )}
      </TeamHeader>
      <main className="page narrow-page">
        <section className="card">
          <p className="eyebrow">{recurring ? "Recurring booking" : "Booking"}</p>
          <h2 className="big-title">{headline?.title}</h2>
          <p className="lede">
            {headline && `${headline.staffName}${headline.staffEmail ? ` · ${headline.staffEmail}` : ""}`}
            {headline?.isPrivate ? " · Private" : ""}
          </p>
          {recurring && first && <p>{describeRecurrence(view.recurrence!, localDate(first.startsAt, zone))}</p>}
          {!admin && (
            <>
              <p className="hint">This is your private link to this booking. Anyone with it can edit or cancel.</p>
              <CopyLink url={location.href} />
            </>
          )}
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
        </section>

        <section className="card">
          <h2>Upcoming</h2>
          {upcoming.length ? <ul className="occ-rows">{upcoming.map(row)}</ul> : <p className="muted">Nothing upcoming.</p>}
          {(past.length > 0 || cancelled.length > 0) && (
            <button className="link-btn" onClick={() => setShowPast((v) => !v)} aria-expanded={showPast}>
              {showPast ? "Hide" : "Show"} past and cancelled ({past.length + cancelled.length})
            </button>
          )}
          {showPast && <ul className="occ-rows dim">{[...past, ...cancelled].map(row)}</ul>}
        </section>
        {!admin && (
          <p>
            <button
              className="link-btn"
              onClick={() => {
                savedBookings.remove(token);
                setNotice("Removed from My bookings on this device. The link still works.");
              }}
            >
              Remove from My bookings on this device
            </button>
          </p>
        )}
      </main>

      {editing && (
        <Modal title="Edit booking" onClose={() => setEditing(null)} wide>
          <BookingForm
            team={view.team}
            rooms={view.rooms}
            categories={view.categories}
            admin={admin}
            people={view.people}
            edit={{ manageBase: base, bookingId: editing.id, seriesRecurring: recurring, headers: {} }}
            initial={{
              roomId: editing.roomId,
              categoryId: editing.categoryId ?? 0,
              title: editing.title,
              staffName: editing.staffName,
              staffEmail: editing.staffEmail ?? "",
              attendance: editing.attendance ? String(editing.attendance) : "",
              description: editing.description,
              isPrivate: editing.isPrivate,
              allDay: editing.allDay,
              date: localDate(editing.startsAt, zone),
              startTime: localHm(editing.startsAt, zone),
              endTime: localHm(editing.endsAt, zone),
              recurrence: view.recurrence,
            }}
            onCancel={() => setEditing(null)}
            onDone={(r) => {
              setEditing(null);
              if (r.kind === "updated") {
                setNotice(`Saved ${r.updated} ${r.updated === 1 ? "booking" : "bookings"}${r.status === "pending" ? " — waiting for approval" : ""}.`);
              }
              load();
            }}
          />
        </Modal>
      )}

      {cancelling && (
        <Modal title="Cancel booking" onClose={() => setCancelling(null)}>
          <div className="stack">
            <p>
              {fmtDate(cancelling.startsAt, zone)}, {fmtTime(cancelling.startsAt, zone)} — {cancelling.title}
            </p>
            {recurring && (
              <fieldset className="scope">
                <legend>Cancel which bookings?</legend>
                {(
                  [
                    ["this", "Only this one"],
                    ["following", "This and following"],
                    ["all", "All upcoming in the series"],
                  ] as [EditScope, string][]
                ).map(([v, label]) => (
                  <label className="radio" key={v}>
                    <input type="radio" name="cscope" checked={scope === v} onChange={() => setScope(v)} />
                    {label}
                  </label>
                ))}
              </fieldset>
            )}
            <div className="actions">
              <button className="btn ghost" onClick={() => setCancelling(null)}>
                Keep it
              </button>
              <button className="btn danger" onClick={doCancel}>
                Cancel booking
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

