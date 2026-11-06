import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { AdminTeam, BookingRules, CalendarBooking, Category, Closure, Room, RuleOverrides, WeeklyHours } from "../../../shared/types";
import { adminEndpoints, api, errorText } from "../../api";
import { HoursEditor } from "../../components/HoursEditor";
import { Modal } from "../../components/Modal";
import { CopyLink, Scheduler } from "../../components/Scheduler";
import { fmtDate, fmtTime, hoursSummary, roomLabel, roomLocation } from "../../lib/time";
import { brandStyle } from "../TeamPage";
import { RulesFields, TimezoneSelect } from "./fields";
import { ActivityList } from "../../components/ActivityList";
import { SubscribeModal } from "../../components/SubscribeModal";
import { useAdmin } from "./AdminShell";

interface Data {
  team: AdminTeam;
  rooms: Room[];
  categories: Category[];
  admins: { name: string; email: string }[];
}

const TABS = ["calendar", "approvals", "rooms", "categories", "closures", "activity", "settings"] as const;
type Tab = (typeof TABS)[number];

export function TeamAdminPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.includes(params.get("tab") as Tab) ? params.get("tab") : "calendar") as Tab;
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<Data>(`/admin/teams/${id}`)
      .then(setData)
      .catch((e) => setError(errorText(e)));
  }, [id]);
  useEffect(load, [load]);

  if (error) return <main className="page"><p className="error">{error}</p></main>;
  if (!data) return <main className="page"><p className="muted">Loading…</p></main>;
  const { team } = data;
  const shareUrl = `${location.origin}/t/${team.shareToken}`;

  return (
    <main className="page" style={brandStyle(team.accentColor)}>
      <div className="page-head">
        <div>
          <p className="eyebrow">
            <Link to="/admin">Teams</Link> /
          </p>
          <h1>{team.name}</h1>
        </div>
        <div className="share-box">
          <span className="hint">Booking link for staff{team.hasPin ? " (PIN protected)" : ""}</span>
          <CopyLink url={shareUrl} />
        </div>
      </div>
      <nav className="tabs" role="tablist" aria-label="Team sections">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setParams({ tab: t })}>
            {t[0].toUpperCase() + t.slice(1)}
            {t === "approvals" && team.pendingCount > 0 && <span className="count">{team.pendingCount}</span>}
          </button>
        ))}
      </nav>
      <div className="tab-body">
        {tab === "calendar" && (
          <Scheduler
            team={team}
            rooms={data.rooms}
            categories={data.categories}
            endpoints={adminEndpoints(team.id)}
            feedToken={team.feedToken}
            adminFeedToken={team.adminFeedToken}
            printPath={`/admin/teams/${team.id}/print`}
          />
        )}
        {tab === "activity" && <ActivityList teamId={team.id} zone={team.timezone} />}
        {tab === "approvals" && <ApprovalsTab team={team} onChange={load} />}
        {tab === "rooms" && <RoomsTab data={data} onChange={load} />}
        {tab === "categories" && <CategoriesTab team={team} categories={data.categories} onChange={load} />}
        {tab === "closures" && <ClosuresTab team={team} rooms={data.rooms} />}
        {tab === "settings" && <SettingsTab team={team} rooms={data.rooms} admins={data.admins} onChange={load} />}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------- Approvals

function ApprovalsTab({ team, onChange }: { team: AdminTeam; onChange: () => void }) {
  type P = CalendarBooking & { roomName: string; categoryName: string };
  const [pending, setPending] = useState<P[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<{ pending: P[] }>(`/admin/teams/${team.id}/pending`)
      .then((r) => setPending(r.pending))
      .catch((e) => setError(errorText(e)));
  }, [team.id]);
  useEffect(load, [load]);

  const decide = async (ids: number[], action: "approve" | "reject") => {
    try {
      await api(`/admin/teams/${team.id}/${action}`, { body: { bookingIds: ids } });
      load();
      onChange();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!pending) return <p className="muted">Loading…</p>;
  const groups = new Map<number, P[]>();
  for (const p of pending) groups.set(p.seriesId, [...(groups.get(p.seriesId) ?? []), p]);
  const z = team.timezone;
  return (
    <section>
      {error && <p className="error">{error}</p>}
      {!pending.length && <div className="card empty-state"><h2>Nothing waiting</h2><p>Bookings for rooms that need approval will appear here.</p></div>}
      <ul className="approval-list">
        {[...groups.values()].map((items) => {
          const f = items[0];
          return (
            <li key={f.seriesId} className="card">
              <div className="approval-head">
                <div>
                  <h3>{f.title}</h3>
                  <p className="muted">
                    {f.roomName} · {f.categoryName} · {f.staffName}
                    {f.staffEmail ? ` (${f.staffEmail})` : ""}
                    {f.attendance ? ` · ${f.attendance} people` : ""}
                  </p>
                  {f.description && <p className="pre">{f.description}</p>}
                </div>
                <div className="row">
                  <button className="btn ghost danger small" onClick={() => decide(items.map((i) => i.id), "reject")}>
                    Decline{items.length > 1 ? ` all ${items.length}` : ""}
                  </button>
                  <button className="btn primary small" onClick={() => decide(items.map((i) => i.id), "approve")}>
                    Approve{items.length > 1 ? ` all ${items.length}` : ""}
                  </button>
                </div>
              </div>
              <ul className="occ-rows compact">
                {items.map((i) => (
                  <li key={i.id} className="occ">
                    <span>
                      {fmtDate(i.startsAt, z)} · {fmtTime(i.startsAt, z)}–{fmtTime(i.endsAt, z)}
                    </span>
                    {items.length > 1 && (
                      <span className="row">
                        <button className="link-btn" onClick={() => decide([i.id], "reject")}>Decline</button>
                        <button className="link-btn" onClick={() => decide([i.id], "approve")}>Approve</button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- Rooms

type RoomDraft = Omit<Room, "id" | "teamId" | "rules"> & { id?: number };

function blankRoom(team: AdminTeam): RoomDraft {
  return {
    name: "",
    code: "",
    building: "",
    campus: "",
    floor: "",
    capacity: null,
    description: "",
    color: "#0b5cad",
    requiresApproval: false,
    active: true,
    allowedCategoryIds: [],
    hours: structuredClone(team.defaultHours),
    overrides: { slotMinutes: null, minMinutes: null, maxMinutes: null, maxDaysAhead: null, bufferMinutes: null, capacityMode: null },
    sortOrder: 0,
  };
}

function RoomsTab({ data, onChange }: { data: Data; onChange: () => void }) {
  const { team, rooms, categories } = data;
  const [draft, setDraft] = useState<RoomDraft | null>(null);
  const [error, setError] = useState("");

  const remove = async (r: Room) => {
    if (!confirm(`Delete ${r.name}? All of its bookings (past and future) will be deleted too. To keep history, mark it inactive instead.`)) return;
    try {
      await api(`/admin/rooms/${r.id}`, { method: "DELETE" });
      onChange();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section>
      <div className="row between">
        <p className="muted">{rooms.length} {rooms.length === 1 ? "room" : "rooms"}. Inactive rooms are hidden from staff but keep their history.</p>
        <button className="btn primary" onClick={() => setDraft(blankRoom(team))}>
          + Add room
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>Room</th>
            <th>Location</th>
            <th>Seats</th>
            <th>Hours</th>
            <th>Status</th>
            <th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rooms.map((r) => (
            <tr key={r.id} className={r.active ? "" : "dim"}>
              <td>
                <span className="dot" style={{ background: r.color }} /> <strong>{roomLabel(r)}</strong>
              </td>
              <td>{roomLocation(r) || "—"}</td>
              <td>{r.capacity ?? "—"}</td>
              <td className="small-text">{hoursSummary(r.hours)}</td>
              <td>
                {!r.active && <span className="badge">Inactive</span>}
                {r.requiresApproval && <span className="badge amber">Approval</span>}
              </td>
              <td className="right">
                <button className="btn small" onClick={() => setDraft({ ...r })}>Edit</button>{" "}
                <button className="btn small" onClick={() => setDraft({ ...r, id: undefined, name: `${r.name} (copy)` })}>Duplicate</button>{" "}
                <button className="btn small ghost danger" onClick={() => remove(r)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {draft && <RoomEditor team={team} categories={categories} rooms={rooms} draft={draft} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); onChange(); }} />}
    </section>
  );
}

function RoomEditor({
  team,
  categories,
  rooms,
  draft,
  onClose,
  onSaved,
}: {
  team: AdminTeam;
  categories: Category[];
  rooms: Room[];
  draft: RoomDraft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [r, setR] = useState<RoomDraft>(draft);
  const [error, setError] = useState("");
  const set = <K extends keyof RoomDraft>(k: K, v: RoomDraft[K]) => setR((p) => ({ ...p, [k]: v }));
  const known = (k: "campus" | "building") => [...new Set(rooms.map((x) => x[k]).filter(Boolean))];

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (r.id) await api(`/admin/rooms/${r.id}`, { method: "PATCH", body: r });
      else await api(`/admin/teams/${team.id}/rooms`, { body: r });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Modal title={r.id ? `Edit ${draft.name}` : "Add room"} onClose={onClose} wide>
      <form className="stack" onSubmit={save}>
        <div className="grid-3">
          <label className="field">
            <span>Room name</span>
            <input value={r.name} onChange={(e) => set("name", e.target.value)} required maxLength={120} />
          </label>
          <label className="field">
            <span>Room number / code <em className="opt">optional</em></span>
            <input value={r.code} onChange={(e) => set("code", e.target.value)} maxLength={40} />
          </label>
          <label className="field">
            <span>Capacity <em className="opt">optional</em></span>
            <input type="number" min={1} value={r.capacity ?? ""} onChange={(e) => set("capacity", e.target.value ? Number(e.target.value) : null)} />
          </label>
          <label className="field">
            <span>Building</span>
            <input list="buildings" value={r.building} onChange={(e) => set("building", e.target.value)} maxLength={120} />
            <datalist id="buildings">{known("building").map((b) => <option key={b} value={b} />)}</datalist>
          </label>
          <label className="field">
            <span>Floor <em className="opt">optional</em></span>
            <input value={r.floor} onChange={(e) => set("floor", e.target.value)} maxLength={40} />
          </label>
          <label className="field">
            <span>Campus</span>
            <input list="campuses" value={r.campus} onChange={(e) => set("campus", e.target.value)} maxLength={120} />
            <datalist id="campuses">{known("campus").map((c) => <option key={c} value={c} />)}</datalist>
          </label>
        </div>
        <label className="field">
          <span>Description <em className="opt">room type, features, equipment, accessibility notes, directions</em></span>
          <textarea rows={4} value={r.description} onChange={(e) => set("description", e.target.value)} maxLength={4000} />
        </label>
        <div className="row wrap">
          <label className="field inline">
            <span>Calendar colour</span>
            <input type="color" value={r.color} onChange={(e) => set("color", e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={r.active} onChange={(e) => set("active", e.target.checked)} />
            Active (taking bookings)
          </label>
          <label className="check">
            <input type="checkbox" checked={r.requiresApproval} onChange={(e) => set("requiresApproval", e.target.checked)} />
            Bookings need admin approval
          </label>
        </div>

        <fieldset>
          <legend>Opening hours</legend>
          <HoursEditor value={r.hours} onChange={(h: WeeklyHours) => set("hours", h)} />
        </fieldset>

        <fieldset>
          <legend>Allowed categories</legend>
          <p className="hint">Leave all unticked to accept every category.</p>
          <div className="row wrap">
            {categories.map((c) => (
              <label className="check" key={c.id}>
                <input
                  type="checkbox"
                  checked={r.allowedCategoryIds.includes(c.id)}
                  onChange={(e) =>
                    set("allowedCategoryIds", e.target.checked ? [...r.allowedCategoryIds, c.id] : r.allowedCategoryIds.filter((x) => x !== c.id))
                  }
                />
                <span className="dot" style={{ background: c.color }} /> {c.name}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Booking rules for this room</legend>
          <p className="hint">Blank fields use the team defaults (Settings tab).</p>
          <RulesFields<RuleOverrides> value={r.overrides} onChange={(o) => set("overrides", o)} defaults={team.rules} />
        </fieldset>

        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary">{r.id ? "Save room" : "Add room"}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Categories

function CategoriesTab({ team, categories, onChange }: { team: AdminTeam; categories: Category[]; onChange: () => void }) {
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState("#0b5cad");

  const save = async (c: Category) => {
    try {
      await api(`/admin/categories/${c.id}`, { method: "PATCH", body: c });
      onChange();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="narrow-section">
      <p className="muted">Categories colour the calendar. Inactive categories can't be chosen for new bookings but stay on old ones.</p>
      {error && <p className="error">{error}</p>}
      <ul className="cat-list">
        {categories.map((c) => (
          <CategoryRow key={`${c.id}-${c.name}-${c.color}-${c.active}`} c={c} onSave={save} onDelete={async () => {
            if (!confirm(`Delete "${c.name}"?`)) return;
            try {
              await api(`/admin/categories/${c.id}`, { method: "DELETE" });
              onChange();
            } catch (e) {
              setError(errorText(e));
            }
          }} />
        ))}
      </ul>
      <form
        className="row wrap add-row"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api(`/admin/teams/${team.id}/categories`, { body: { name, color, sortOrder: categories.length } });
            setName("");
            onChange();
          } catch (err) {
            setError(errorText(err));
          }
        }}
      >
        <input type="color" aria-label="New category colour" value={color} onChange={(e) => setColor(e.target.value)} />
        <input placeholder="New category name" aria-label="New category name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
        <button className="btn">Add category</button>
      </form>
    </section>
  );
}

function CategoryRow({ c, onSave, onDelete }: { c: Category; onSave: (c: Category) => void; onDelete: () => void }) {
  const [d, setD] = useState(c);
  const dirty = d.name !== c.name || d.color !== c.color || d.active !== c.active;
  return (
    <li className={d.active ? "" : "dim"}>
      <input type="color" aria-label={`${c.name} colour`} value={d.color} onChange={(e) => setD({ ...d, color: e.target.value })} />
      <input aria-label="Category name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} maxLength={60} />
      <label className="check">
        <input type="checkbox" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} /> Active
      </label>
      {dirty && <button className="btn small primary" onClick={() => onSave(d)}>Save</button>}
      <button className="btn small ghost danger" onClick={onDelete}>Delete</button>
    </li>
  );
}

// ---------------------------------------------------------------- Closures

function ClosuresTab({ team, rooms }: { team: AdminTeam; rooms: Room[] }) {
  const [list, setList] = useState<Closure[]>([]);
  const [f, setF] = useState({ startDate: "", endDate: "", roomId: "", reason: "" });
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<{ closures: Closure[] }>(`/admin/teams/${team.id}/closures`).then((r) => setList(r.closures)).catch((e) => setError(errorText(e)));
  }, [team.id]);
  useEffect(load, [load]);
  const roomName = new Map(rooms.map((r) => [r.id, roomLabel(r)]));

  return (
    <section className="narrow-section">
      <p className="muted">Closed dates block new bookings (existing bookings aren't touched). Use them for holidays, reading week or a room being out of service.</p>
      <form
        className="card grid-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api(`/admin/teams/${team.id}/closures`, { body: { ...f, endDate: f.endDate || f.startDate, roomId: f.roomId ? Number(f.roomId) : null } });
            setF({ startDate: "", endDate: "", roomId: "", reason: "" });
            load();
          } catch (err) {
            setError(errorText(err));
          }
        }}
      >
        <label className="field">
          <span>From</span>
          <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} required />
        </label>
        <label className="field">
          <span>To <em className="opt">optional</em></span>
          <input type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
        </label>
        <label className="field">
          <span>Applies to</span>
          <select value={f.roomId} onChange={(e) => setF({ ...f, roomId: e.target.value })}>
            <option value="">Whole team</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{roomLabel(r)}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Reason</span>
          <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Reading week" maxLength={200} />
        </label>
        <div className="actions full">
          <button className="btn primary">Add closure</button>
        </div>
      </form>
      {error && <p className="error">{error}</p>}
      <ul className="closure-list">
        {list.map((c) => (
          <li key={c.id}>
            <strong>{c.startDate === c.endDate ? c.startDate : `${c.startDate} → ${c.endDate}`}</strong>
            <span>{c.roomId ? roomName.get(c.roomId) ?? "Room" : "Whole team"}</span>
            <span className="muted">{c.reason}</span>
            <button className="btn small ghost danger" onClick={async () => { await api(`/admin/closures/${c.id}`, { method: "DELETE" }); load(); }}>
              Remove
            </button>
          </li>
        ))}
        {!list.length && <li className="muted">No closures.</li>}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- Settings

function SettingsTab({
  team,
  rooms,
  admins,
  onChange,
}: {
  team: AdminTeam;
  rooms: Room[];
  admins: { name: string; email: string }[];
  onChange: () => void;
}) {
  const navigate = useNavigate();
  const { me } = useAdmin();
  const [feeds, setFeeds] = useState(false);
  const [s, setS] = useState({
    name: team.name,
    description: team.description,
    timezone: team.timezone,
    accentColor: team.accentColor,
    logoDataUrl: team.logoDataUrl,
    rules: team.rules as BookingRules,
    requiredFields: team.requiredFields,
    defaultHours: team.defaultHours,
  });
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const save = async (extra: Record<string, unknown> = {}) => {
    setError("");
    try {
      await api(`/admin/teams/${team.id}`, { method: "PATCH", body: { ...s, ...extra } });
      setMsg("Saved.");
      setTimeout(() => setMsg(""), 2500);
      onChange();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="settings">
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <h2>General</h2>
        <div className="grid-2">
          <label className="field">
            <span>Team name</span>
            <input value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} required maxLength={120} />
          </label>
          <TimezoneSelect value={s.timezone} onChange={(v) => setS({ ...s, timezone: v })} />
        </div>
        <label className="field">
          <span>Description shown to staff <em className="opt">optional</em></span>
          <textarea rows={2} value={s.description} onChange={(e) => setS({ ...s, description: e.target.value })} maxLength={1000} />
        </label>

        <h2>Branding</h2>
        <div className="row wrap">
          <label className="field inline">
            <span>Accent colour</span>
            <input type="color" value={s.accentColor} onChange={(e) => setS({ ...s, accentColor: e.target.value })} />
          </label>
          <label className="field inline">
            <span>Logo</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 290_000) return setError("Choose a logo under 290 KB.");
                const reader = new FileReader();
                reader.onload = () => setS((p) => ({ ...p, logoDataUrl: String(reader.result) }));
                reader.readAsDataURL(file);
              }}
            />
          </label>
          {s.logoDataUrl && (
            <>
              <img src={s.logoDataUrl} alt="Current logo" className="team-logo" />
              <button type="button" className="link-btn" onClick={() => setS({ ...s, logoDataUrl: null })}>Remove logo</button>
            </>
          )}
        </div>

        <h2>Default booking rules</h2>
        <p className="hint">Each room can override these.</p>
        <RulesFields<BookingRules> value={s.rules} onChange={(r) => setS({ ...s, rules: r })} />

        <h2>Required fields</h2>
        <p className="hint">Title, category, date, time and staff name are always required.</p>
        <div className="row wrap">
          {(
            [
              ["email", "Email"],
              ["attendance", "Expected attendance"],
              ["description", "Description"],
            ] as const
          ).map(([k, label]) => (
            <label className="check" key={k}>
              <input type="checkbox" checked={s.requiredFields[k]} onChange={(e) => setS({ ...s, requiredFields: { ...s.requiredFields, [k]: e.target.checked } })} />
              {label}
            </label>
          ))}
        </div>

        <h2>Default hours for new rooms</h2>
        <HoursEditor value={s.defaultHours} onChange={(h) => setS({ ...s, defaultHours: h })} />

        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions sticky">
          {msg && <span className="notice">{msg}</span>}
          <button className="btn primary">Save settings</button>
        </div>
      </form>

      <div className="card stack">
        <h2>Access</h2>
        <p>
          Staff book through this link. Regenerating it makes the old link (and the calendar feed links) stop working, which is useful if it was shared too widely.
          Existing bookings and their private links aren't affected.
        </p>
        <CopyLink url={`${location.origin}/t/${team.shareToken}`} />
        <div>
          <button
            className="btn"
            onClick={async () => {
              if (!confirm("Make a new link? The current link will stop working immediately.")) return;
              await api(`/admin/teams/${team.id}/regenerate-link`, { body: {} });
              onChange();
            }}
          >
            Regenerate link
          </button>
        </div>
        <h3>Calendar feeds</h3>
        <p className="hint">Subscription links for Outlook, Google and Apple Calendar: one for staff (private bookings hidden) and one for admins (full details).</p>
        <div>
          <button className="btn" onClick={() => setFeeds(true)}>Show feed links</button>
        </div>
        {feeds && <SubscribeModal teamName={team.name} rooms={rooms} feedToken={team.feedToken} adminFeedToken={team.adminFeedToken} onClose={() => setFeeds(false)} />}
        <h3>Admins for this team</h3>
        <p className="hint">
          {admins.length ? admins.map((a) => `${a.name} (${a.email})`).join(", ") : "No team admins yet."} The super admin can see every team.
          {me.isSuper ? " Change who manages which team under Admin accounts." : ""}
        </p>
        <h3>Team PIN {team.hasPin ? <span className="badge">On</span> : <span className="badge">Off</span>}</h3>
        <p className="hint">Optional. If set, staff enter it once per device before they can see or book rooms.</p>
        <div className="row wrap">
          <input inputMode="numeric" pattern="\d{4,8}" placeholder="4–8 digits" aria-label="New PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} style={{ width: "9rem" }} />
          <button className="btn" disabled={pin.length < 4} onClick={() => { save({ pin }); setPin(""); }}>
            {team.hasPin ? "Change PIN" : "Set PIN"}
          </button>
          {team.hasPin && <button className="btn ghost" onClick={() => save({ pin: "" })}>Remove PIN</button>}
        </div>
      </div>

      {me.isSuper && <div className="card stack danger-zone">
        <h2>Delete team</h2>
        <p>Deletes the team with all of its rooms, categories, closures and bookings. This can't be undone.</p>
        <div>
          <button
            className="btn danger"
            onClick={async () => {
              const typed = prompt(`Type the team name (${team.name}) to delete it permanently.`);
              if (typed !== team.name) return;
              await api(`/admin/teams/${team.id}`, { method: "DELETE" });
              navigate("/admin");
            }}
          >
            Delete this team
          </button>
        </div>
      </div>}
    </section>
  );
}
