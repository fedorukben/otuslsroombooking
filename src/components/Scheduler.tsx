import { lazy, Suspense, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { CalendarBooking, Category, PublicTeam, Room } from "../../shared/types";
import { api, errorText, type Endpoints } from "../api";
import { savedBookings } from "../lib/storage";
import { fmtDate, fmtTime, hoursSummary, roomLabel, roomLocation, todayIn, toHm } from "../lib/time";
import { BookingForm, type FormState } from "./BookingForm";
import { DayGrid } from "./DayGrid";
import { FreeRoomFinder } from "./FreeRoomFinder";
import { SubscribeModal } from "./SubscribeModal";
import { Modal } from "./Modal";
const RoomCalendar = lazy(() => import("./RoomCalendar").then((m) => ({ default: m.RoomCalendar })));

type View = "day" | "room" | "find" | "rooms";

export function Scheduler({
  team,
  rooms,
  categories,
  endpoints,
  feedToken,
  adminFeedToken,
  printPath,
}: {
  team: PublicTeam;
  rooms: Room[];
  categories: Category[];
  endpoints: Endpoints;
  feedToken?: string;
  adminFeedToken?: string;
  printPath: string;
}) {
  const admin = endpoints.admin;
  const zone = team.timezone;
  const navigate = useNavigate();
  const [view, setView] = useState<View>("day");
  const [date, setDate] = useState(todayIn(zone));
  const [roomId, setRoomId] = useState<number>(rooms[0]?.id ?? 0);
  const [campus, setCampus] = useState("");
  const [building, setBuilding] = useState("");
  const [minCap, setMinCap] = useState("");
  const [search, setSearch] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [form, setForm] = useState<Partial<FormState> | null>(null);
  const [created, setCreated] = useState<{ token: string; status: string; count: number } | null>(null);
  const [open, setOpen] = useState<CalendarBooking | null>(null);
  const [openErr, setOpenErr] = useState("");
  const [subscribing, setSubscribing] = useState(false);

  const campuses = useMemo(() => [...new Set(rooms.map((r) => r.campus).filter(Boolean))].sort(), [rooms]);
  const buildings = useMemo(
    () => [...new Set(rooms.filter((r) => !campus || r.campus === campus).map((r) => r.building).filter(Boolean))].sort(),
    [rooms, campus],
  );
  const filtered = rooms.filter(
    (r) =>
      (!campus || r.campus === campus) &&
      (!building || r.building === building) &&
      (!minCap || (r.capacity ?? 0) >= Number(minCap)) &&
      (!search || `${r.name} ${r.code} ${r.description} ${r.building}`.toLowerCase().includes(search.toLowerCase())),
  );
  const calRoom = rooms.find((r) => r.id === roomId) ?? filtered[0] ?? rooms[0];
  const catById = new Map(categories.map((c) => [c.id, c]));
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const mine = admin ? null : new Map(savedBookings.list().map((b) => [b.seriesId, b.token]));

  const startBooking = (r: Room, d: string, s: number, e: number) =>
    setForm({ roomId: r.id, date: d, startTime: toHm(s), endTime: e >= 1440 ? "23:59" : toHm(e) });

  async function manage(b: CalendarBooking) {
    setOpenErr("");
    try {
      if (admin) {
        const { manageToken } = await api<{ manageToken: string }>(`/admin/bookings/${b.id}/token`);
        navigate(`/admin/manage/${manageToken}`);
      } else {
        const token = mine?.get(b.seriesId);
        if (token) navigate(`/m/${token}`);
      }
    } catch (err) {
      setOpenErr(errorText(err));
    }
  }

  if (!rooms.length) {
    return <p className="empty">{admin ? "Add a room on the Rooms tab to start taking bookings." : "This team has no rooms available yet."}</p>;
  }

  return (
    <div className="scheduler">
      <div className="toolbar">
        <div className="segmented" role="tablist" aria-label="View">
          {(
            [
              ["day", "Day · all rooms"],
              ["room", "Room calendar"],
              ["find", "Find a free room"],
              ["rooms", "Room details"],
            ] as [View, string][]
          ).map(([v, label]) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
              {label}
            </button>
          ))}
        </div>
        <div className="filters">
          {view === "find" ? null : view === "room" ? (
            <label className="field inline">
              <span>Room</span>
              <select value={calRoom?.id} onChange={(e) => setRoomId(Number(e.target.value))}>
                {filtered.map((r) => (
                  <option key={r.id} value={r.id}>
                    {roomLabel(r)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field inline">
              <span className="sr-only">Search rooms</span>
              <input type="search" placeholder="Search rooms…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
          )}
          {view !== "find" && campuses.length > 1 && (
            <label className="field inline">
              <span className="sr-only">Campus</span>
              <select value={campus} onChange={(e) => { setCampus(e.target.value); setBuilding(""); }}>
                <option value="">All campuses</option>
                {campuses.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
          )}
          {view !== "find" && buildings.length > 1 && (
            <label className="field inline">
              <span className="sr-only">Building</span>
              <select value={building} onChange={(e) => setBuilding(e.target.value)}>
                <option value="">All buildings</option>
                {buildings.map((b) => <option key={b}>{b}</option>)}
              </select>
            </label>
          )}
          {view !== "find" && <label className="field inline">
            <span className="sr-only">Minimum seats</span>
            <input type="number" min={1} placeholder="Seats ≥" value={minCap} onChange={(e) => setMinCap(e.target.value)} style={{ width: "6.5rem" }} />
          </label>}
          <button className="btn primary" onClick={() => setForm({ roomId: (view === "room" ? calRoom : filtered[0] ?? rooms[0]).id, date: date >= todayIn(zone) ? date : todayIn(zone) })}>
            + New booking
          </button>
        </div>
      </div>

      <div className="sub-actions">
        {feedToken && (
          <button className="link-btn" onClick={() => setSubscribing(true)}>
            Subscribe in Outlook / Google / Apple Calendar
          </button>
        )}
        <Link
          className="link-btn"
          to={`${printPath}?from=${view === "day" ? date : todayIn(zone)}${view === "room" && calRoom ? `&room=${calRoom.id}` : ""}`}
        >
          Print or save as PDF
        </Link>
      </div>

      {view === "find" && <FreeRoomFinder zone={zone} rooms={rooms} endpoints={endpoints} onBook={(init) => setForm(init)} />}

      {view === "day" && (
        <DayGrid
          zone={zone}
          rooms={filtered}
          categories={categories}
          endpoints={endpoints}
          date={date}
          onDateChange={setDate}
          refreshKey={refreshKey}
          onSlot={startBooking}
          onOpen={setOpen}
        />
      )}
      {view === "room" && calRoom && (
        <Suspense fallback={<p className="muted">Loading calendar…</p>}>
        <RoomCalendar
          zone={zone}
          room={calRoom}
          categories={categories}
          endpoints={endpoints}
          refreshKey={refreshKey}
          onSelect={(d, s, e) => startBooking(calRoom, d, s, e)}
          onOpen={setOpen}
        />
        </Suspense>
      )}
      {view === "rooms" && (
        <ul className="room-cards">
          {filtered.map((r) => (
            <li key={r.id} className="room-card" style={{ ["--room" as string]: r.color }}>
              <div className="room-card-head">
                <h3>{roomLabel(r)}</h3>
                {r.capacity && <span className="badge">{r.capacity} seats</span>}
                {r.requiresApproval && <span className="badge amber">Needs approval</span>}
                {!r.active && <span className="badge">Inactive</span>}
              </div>
              <p className="loc">{roomLocation(r) || "—"}</p>
              {r.description && <p className="desc">{r.description}</p>}
              <p className="hours">{hoursSummary(r.hours)}</p>
              <div className="row">
                <button className="btn ghost small" onClick={() => { setRoomId(r.id); setView("room"); }}>
                  View calendar
                </button>
                <button className="btn small" onClick={() => setForm({ roomId: r.id, date: todayIn(zone) })}>
                  Book
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="legend" aria-label="Category colours">
        {categories.filter((c) => c.active).map((c) => (
          <span key={c.id}>
            <i style={{ background: c.color }} /> {c.name}
          </span>
        ))}
        <span>
          <i className="pending-swatch" /> Pending approval
        </span>
      </div>

      {form && (
        <Modal title="New booking" onClose={() => setForm(null)} wide>
          <BookingForm
            team={team}
            rooms={rooms.filter((r) => admin || r.active)}
            categories={categories}
            admin={admin}
            initial={form}
            endpoints={endpoints}
            onCancel={() => setForm(null)}
            onDone={(res) => {
              setForm(null);
              setRefreshKey((k) => k + 1);
              if (res.kind === "created") {
                const r = roomById.get(res.state.roomId);
                if (!admin) {
                  savedBookings.add({
                    token: res.result.manageToken,
                    seriesId: res.result.seriesId,
                    title: res.state.title,
                    teamName: team.name,
                    roomName: r ? roomLabel(r) : "",
                    firstStart: `${res.state.date} ${res.state.allDay ? "all day" : res.state.startTime}`,
                    recurring: !!res.state.recurrence,
                    savedAt: new Date().toISOString(),
                  });
                }
                setCreated({ token: res.result.manageToken, status: res.result.status, count: res.result.created });
              }
            }}
          />
        </Modal>
      )}

      {created && (
        <Modal title={created.status === "pending" ? "Request sent" : "Booked"} onClose={() => setCreated(null)}>
          <div className="stack">
            <p className="lede">
              {created.count === 1 ? "Your booking" : `${created.count} bookings`}{" "}
              {created.status === "pending" ? "are holding the time and waiting for an admin to approve them." : "are confirmed."}
            </p>
            {!admin && (
              <>
                <p>
                  Keep this private link to change or cancel later. It's also saved under <strong>My bookings</strong> on this device. Anyone with
                  the link can edit the booking.
                </p>
                <CopyLink url={`${location.origin}/m/${created.token}`} />
              </>
            )}
            <div className="actions">
              <Link className="btn ghost" to={admin ? `/admin/manage/${created.token}` : `/m/${created.token}`}>
                Open booking
              </Link>
              <button className="btn primary" onClick={() => setCreated(null)}>
                Done
              </button>
            </div>
          </div>
        </Modal>
      )}

      {subscribing && feedToken && (
        <SubscribeModal teamName={team.name} rooms={rooms.filter((r) => r.active)} feedToken={feedToken} adminFeedToken={adminFeedToken} onClose={() => setSubscribing(false)} />
      )}

      {open && (
        <Modal title={open.title} onClose={() => setOpen(null)}>
          <dl className="details">
            <dt>When</dt>
            <dd>
              {fmtDate(open.startsAt, zone)}, {fmtTime(open.startsAt, zone)} – {fmtTime(open.endsAt, zone)}
              {open.recurring && <span className="badge">Repeats</span>}
            </dd>
            <dt>Room</dt>
            <dd>{roomById.get(open.roomId) ? roomLabel(roomById.get(open.roomId)!) : "—"}</dd>
            {open.status === "pending" && (
              <>
                <dt>Status</dt>
                <dd>
                  <span className="badge amber">Pending approval</span>
                </dd>
              </>
            )}
            {!open.masked && (
              <>
                <dt>Category</dt>
                <dd>{open.categoryId ? catById.get(open.categoryId)?.name ?? "—" : "—"}</dd>
                <dt>Staff</dt>
                <dd>
                  {open.staffName}
                  {open.staffEmail ? ` · ${open.staffEmail}` : ""}
                </dd>
                {open.attendance && (
                  <>
                    <dt>Attendance</dt>
                    <dd>{open.attendance}</dd>
                  </>
                )}
                {open.description && (
                  <>
                    <dt>Notes</dt>
                    <dd className="pre">{open.description}</dd>
                  </>
                )}
                {open.isPrivate && (
                  <>
                    <dt>Visibility</dt>
                    <dd>Private — members see “Busy”</dd>
                  </>
                )}
              </>
            )}
            {open.masked && (
              <>
                <dt>Details</dt>
                <dd className="muted">This booking is private.</dd>
              </>
            )}
          </dl>
          {openErr && <p className="error">{openErr}</p>}
          <div className="actions">
            {(admin || mine?.has(open.seriesId)) && (
              <button className="btn primary" onClick={() => manage(open)}>
                Edit or cancel
              </button>
            )}
            <button className="btn ghost" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-link">
      <input readOnly value={url} aria-label="Link" onFocus={(e) => e.target.select()} />
      <button
        type="button"
        className="btn small"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            /* clipboard blocked; the field is selectable */
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

