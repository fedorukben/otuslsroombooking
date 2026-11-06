import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { AdminTeam, BookingRules, CalendarBooking, Category, Closure, Person, Room, RuleOverrides, WeeklyHours } from "../../../shared/types";
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
import { SortableList } from "../../components/SortableList";
import { RowMenu } from "../../components/RowMenu";

export interface Locations {
  campuses: { id: number; name: string; roomCount: number }[];
  buildings: { id: number; name: string; code: string; campusId: number | null; roomCount: number }[];
}

interface Data {
  team: AdminTeam;
  rooms: Room[];
  categories: Category[];
  admins: { name: string; email: string }[];
  people: string[];
}

const TABS = ["calendar", "approvals", "rooms", "people", "categories", "closures", "activity", "settings"] as const;
type Tab = (typeof TABS)[number];

export function TeamAdminPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const rawTab = params.get("tab") === "locations" ? "rooms" : params.get("tab");
  const tab = (TABS.includes(rawTab as Tab) ? rawTab : "calendar") as Tab;
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
            people={data.people}
          />
        )}
        {tab === "activity" && <ActivityList teamId={team.id} zone={team.timezone} />}
        {tab === "people" && <PeopleTab team={team} onChange={load} />}
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
  const [locs, setLocs] = useState<Locations>({ campuses: [], buildings: [] });
  const loadLocs = useCallback(() => {
    api<Locations>(`/admin/teams/${team.id}/locations`).then(setLocs).catch(() => undefined);
  }, [team.id]);
  useEffect(loadLocs, [loadLocs]);

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
          {!rooms.length && <tr><td colSpan={6} className="muted">No rooms yet. Add your campuses and buildings below, then add a room.</td></tr>}
        </tbody>
      </table>
      <div className="section-divider" id="locations">
        <h2>Campuses and buildings</h2>
      </div>
      <LocationsTab team={team} onChange={() => { onChange(); loadLocs(); }} />
      {draft && <RoomEditor team={team} categories={categories} locs={locs} onLocs={setLocs} draft={draft} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); onChange(); loadLocs(); }} />}
    </section>
  );
}

function RoomEditor({
  team,
  categories,
  locs,
  onLocs,
  draft,
  onClose,
  onSaved,
}: {
  team: AdminTeam;
  categories: Category[];
  locs: Locations;
  onLocs: (l: Locations) => void;
  draft: RoomDraft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [r, setR] = useState<RoomDraft>(draft);
  const [error, setError] = useState("");
  const set = <K extends keyof RoomDraft>(k: K, v: RoomDraft[K]) => setR((p) => ({ ...p, [k]: v }));
  const [adding, setAdding] = useState<"campus" | "building" | null>(null);
  const [newName, setNewName] = useState("");
  const campusOf = (bName: string) => {
    const b = locs.buildings.find((x) => x.name.toLowerCase() === bName.toLowerCase());
    return b?.campusId ? locs.campuses.find((c) => c.id === b.campusId)?.name ?? "" : "";
  };
  const campusId = locs.campuses.find((c) => c.name.toLowerCase() === r.campus.toLowerCase())?.id ?? null;
  const buildingOptions = locs.buildings.filter((b) => !r.campus || b.campusId === campusId || b.campusId === null);
  const addLocation = async () => {
    const name = newName.trim();
    if (!name || !adding) return;
    try {
      const next = await api<Locations>(`/admin/teams/${team.id}/${adding === "campus" ? "campuses" : "buildings"}`, {
        body: adding === "campus" ? { name } : { name, campusId },
      });
      onLocs(next);
      if (adding === "campus") setR((p) => ({ ...p, campus: name, building: "" }));
      else setR((p) => ({ ...p, building: name }));
      setAdding(null);
      setNewName("");
    } catch (err) {
      setError(errorText(err));
    }
  };

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
            <span>Campus</span>
            <select
              value={locs.campuses.some((c) => c.name.toLowerCase() === r.campus.toLowerCase()) ? locs.campuses.find((c) => c.name.toLowerCase() === r.campus.toLowerCase())!.name : r.campus ? "__keep" : ""}
              onChange={(e) => {
                if (e.target.value === "__add") { setAdding("campus"); setNewName(""); return; }
                if (e.target.value === "__keep") return;
                setR((p) => ({ ...p, campus: e.target.value, building: e.target.value && campusOf(p.building) && campusOf(p.building) !== e.target.value ? "" : p.building }));
              }}
            >
              <option value="">No campus</option>
              {r.campus && !locs.campuses.some((c) => c.name.toLowerCase() === r.campus.toLowerCase()) && <option value="__keep">{r.campus}</option>}
              {locs.campuses.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              <option value="__add">+ Add a new campus…</option>
            </select>
          </label>
          <label className="field">
            <span>Building</span>
            <select
              value={locs.buildings.some((b) => b.name.toLowerCase() === r.building.toLowerCase()) ? locs.buildings.find((b) => b.name.toLowerCase() === r.building.toLowerCase())!.name : r.building ? "__keep" : ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__add") { setAdding("building"); setNewName(""); return; }
                if (v === "__keep") return;
                const c = campusOf(v);
                setR((p) => ({ ...p, building: v, campus: c || p.campus }));
              }}
            >
              <option value="">No building</option>
              {r.building && !locs.buildings.some((b) => b.name.toLowerCase() === r.building.toLowerCase()) && <option value="__keep">{r.building}</option>}
              {buildingOptions.map((b) => <option key={b.id} value={b.name}>{b.name}{b.code ? ` (${b.code})` : ""}</option>)}
              <option value="__add">+ Add a new building…</option>
            </select>
            {r.campus && <small className="hint">Showing buildings on {r.campus}.</small>}
          </label>
          <label className="field">
            <span>Floor <em className="opt">optional</em></span>
            <input value={r.floor} onChange={(e) => set("floor", e.target.value)} maxLength={40} />
          </label>
          {adding && (
            <div className="add-location full">
              <label className="field inline">
                <span>New {adding}{adding === "building" && r.campus ? ` on ${r.campus}` : ""}</span>
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLocation(); } if (e.key === "Escape") { e.stopPropagation(); setAdding(null); } }}
                  maxLength={120}
                />
              </label>
              <button type="button" className="btn small primary" onClick={addLocation}>Add</button>
              <button type="button" className="btn small ghost" onClick={() => setAdding(null)}>Cancel</button>
            </div>
          )}
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
      <p className="hint">Drag the handle to change the order categories appear in the booking form and the calendar legend.</p>
      <SortableList
        className="cat-list"
        items={categories}
        label={(c) => c.name}
        onReorder={async (ids) => {
          try {
            await api(`/admin/teams/${team.id}/order/categories`, { body: { ids } });
            onChange();
          } catch (e) {
            setError(errorText(e));
          }
        }}
        render={(c) => (
          <CategoryRow key={`${c.id}-${c.name}-${c.color}-${c.active}`} c={c} onSave={save} onDelete={async () => {
            if (!confirm(`Delete "${c.name}"?`)) return;
            try {
              await api(`/admin/categories/${c.id}`, { method: "DELETE" });
              onChange();
            } catch (e) {
              setError(errorText(e));
            }
          }} />
        )}
      />
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
    <div className={`cat-row ${d.active ? "" : "dim"}`}>
      <input type="color" aria-label={`${c.name} colour`} value={d.color} onChange={(e) => setD({ ...d, color: e.target.value })} />
      <input aria-label="Category name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} maxLength={60} />
      <label className="check">
        <input type="checkbox" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} /> Active
      </label>
      {dirty && <button className="btn small primary" onClick={() => onSave(d)}>Save</button>}
      <button className="btn small ghost danger" onClick={onDelete}>Delete</button>
    </div>
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
    peopleOnly: team.peopleOnly,
    linkAccess: team.linkAccess,
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

        <h2>How staff get in</h2>
        <label className="check">
          <input type="checkbox" checked={s.linkAccess} onChange={(e) => setS({ ...s, linkAccess: e.target.checked })} />
          Also allow booking through the team link without signing in
        </label>
        <p className="hint">
          Staff with a sign-in (People tab → Give sign-in) always book from their dashboard. Untick this once everyone has a sign-in, so only
          signed-in staff can book. Existing bookings and their private links keep working either way.
        </p>

        <h2>People list</h2>
        <label className="check">
          <input type="checkbox" checked={s.peopleOnly} onChange={(e) => setS({ ...s, peopleOnly: e.target.checked })} />
          Staff must choose their name from the People list (admins can still book for anyone)
        </label>
        <p className="hint">When this is off, the list is a convenience and staff can type any name.</p>

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

// ---------------------------------------------------------------- People

function PeopleTab({ team, onChange }: { team: AdminTeam; onChange: () => void }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [f, setF] = useState({ name: "", email: "", role: "" });
  const [editing, setEditing] = useState<Person | null>(null);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState("");
  const [search, setSearch] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<{ people: Person[] }>(`/admin/teams/${team.id}/people`).then((r) => setPeople(r.people)).catch((e) => setError(errorText(e)));
  }, [team.id]);
  useEffect(load, [load]);
  const changed = () => {
    load();
    onChange();
  };
  const shown = people.filter((p) => !search || `${p.name} ${p.email} ${p.role}`.toLowerCase().includes(search.toLowerCase()));
  const [linkModal, setLinkModal] = useState<{ title: string; url: string; note: string } | null>(null);
  const giveAccess = async (p: Person) => {
    setError("");
    try {
      const r = await api<{ path?: string; linked?: boolean }>(`/admin/people/${p.id}/access`, { body: {} });
      if (r.linked) setMsg(`${p.name} already had an account, so it's now connected to this team. They can sign in with their usual password.`);
      else setLinkModal({ title: `Sign-in invite for ${p.name}`, url: location.origin + r.path, note: `Send this to ${p.name}. They'll set a password and land on their dashboard. It works once and expires in 7 days.` });
      changed();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const resetLink = async (p: Person) => {
    setError("");
    try {
      const r = await api<{ path: string }>(`/admin/people/${p.id}/reset-link`, { body: {} });
      setLinkModal({ title: `Password reset link for ${p.name}`, url: location.origin + r.path, note: `Send this to ${p.name}. It lets them choose a new password, works once, and expires in 24 hours.` });
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="people-section">
      <p className="muted">
        The people who book rooms for this team. They appear as a dropdown on the booking form, and their email is filled in automatically.
        Use <strong>Give sign-in</strong> to send someone an invite to their own account; they then book from their dashboard.
        {team.peopleOnly ? " Staff can only book under a name on this list (Settings)." : " Staff can still type a name that isn't listed (change this in Settings)."}
      </p>
      {error && <p className="error">{error}</p>}
      {msg && <p className="notice">{msg}</p>}
      <form
        className="card grid-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await api(`/admin/teams/${team.id}/people`, { body: f });
            setF({ name: "", email: "", role: "" });
            changed();
          } catch (err) {
            setError(errorText(err));
          }
        }}
      >
        <label className="field"><span>Name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} /></label>
        <label className="field"><span>Email <em className="opt">optional</em></span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label className="field"><span>Role <em className="opt">optional</em></span><input value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} placeholder="e.g. Peer Educator" maxLength={120} /></label>
        <div className="actions"><button className="btn primary">Add person</button></div>
      </form>
      <div className="row between">
        <input type="search" placeholder="Search people…" aria-label="Search people" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 320 }} />
        <button className="btn" onClick={() => setImporting(true)}>Import a list…</button>
      </div>
      <table className="table people-table">
        <thead><tr><th>Person</th><th>Email</th><th>Sign-in</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {shown.map((p) => (
            <tr key={p.id} className={p.active ? "" : "dim"}>
              <td>
                <div className="person-name">
                  <strong>{p.name}</strong>
                  {p.isAdmin && <span className="badge">Admin</span>}
                  {!p.active && <span className="badge">Inactive</span>}
                </div>
                {p.role && <div className="person-role">{p.role}</div>}
              </td>
              <td className="email-cell">{p.email ? <span title={p.email}>{p.email}</span> : <span className="muted">No email</span>}</td>
              <td className="nowrap">
                {p.hasLogin ? <span className="badge ok">Can sign in</span> : p.invitePending ? <span className="badge amber">Invite sent</span> : <span className="muted small-text">Not yet</span>}
              </td>
              <td className="right actions-cell">
                {!p.hasLogin ? (
                  <button className="btn small primary" onClick={() => giveAccess(p)}>{p.invitePending ? "New invite link" : "Give sign-in"}</button>
                ) : (
                  <button className="btn small" onClick={() => setEditing(p)}>Edit</button>
                )}
                <RowMenu
                  label={`More actions for ${p.name}`}
                  items={[
                    ...(!p.hasLogin ? [{ label: "Edit", onSelect: () => setEditing(p) }] : []),
                    ...(p.hasLogin && !p.isAdmin
                      ? [
                          { label: "Reset password link", onSelect: () => resetLink(p) },
                          {
                            label: "Remove sign-in",
                            onSelect: async () => {
                              if (!confirm(`Remove ${p.name}'s sign-in for this team? They stay on the list and their bookings are unchanged.`)) return;
                              await api(`/admin/people/${p.id}/access`, { method: "DELETE" }).catch((e) => setError(errorText(e)));
                              changed();
                            },
                          },
                        ]
                      : []),
                    {
                      label: "Remove from list",
                      danger: true,
                      onSelect: async () => {
                        if (!confirm(`Remove ${p.name} from the list? Their existing bookings stay as they are.`)) return;
                        await api(`/admin/people/${p.id}`, { method: "DELETE" }).catch((e) => setError(errorText(e)));
                        changed();
                      },
                    },
                  ]}
                />
              </td>
            </tr>
          ))}
          {!shown.length && <tr><td colSpan={4} className="muted">No people yet.</td></tr>}
        </tbody>
      </table>

      {editing && (
        <Modal title={`Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api(`/admin/people/${editing.id}`, { method: "PATCH", body: editing });
                setEditing(null);
                changed();
              } catch (err) {
                setError(errorText(err));
              }
            }}
          >
            <label className="field"><span>Name</span><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required maxLength={120} /></label>
            <label className="field"><span>Email</span><input type="email" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} /></label>
            <label className="field"><span>Role</span><input value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })} maxLength={120} /></label>
            <label className="check"><input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Active (shown in the dropdown)</label>
            <div className="actions">
              <button type="button" className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn primary">Save</button>
            </div>
          </form>
        </Modal>
      )}

      {linkModal && (
        <Modal title={linkModal.title} onClose={() => setLinkModal(null)}>
          <div className="stack">
            <p>{linkModal.note}</p>
            <CopyLink url={linkModal.url} />
            <p className="warn-text small-text">Copy it now. For security it won't be shown again.</p>
            <div className="actions"><button className="btn primary" onClick={() => setLinkModal(null)}>Done</button></div>
          </div>
        </Modal>
      )}

      {importing && (
        <Modal title="Import people" onClose={() => setImporting(false)}>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const r = await api<{ added: number; skipped: string[] }>(`/admin/teams/${team.id}/people/import`, { body: { text: importText } });
                setMsg(`Added ${r.added}.${r.skipped.length ? ` Skipped ${r.skipped.length}: ${r.skipped.slice(0, 5).join("; ")}${r.skipped.length > 5 ? "…" : ""}` : ""}`);
                setImporting(false);
                setImportText("");
                changed();
              } catch (err) {
                setError(errorText(err));
              }
            }}
          >
            <p>One person per line: <code>Name, email, role</code>. Email and role are optional. You can paste straight from a spreadsheet.</p>
            <textarea rows={10} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={"Priya Patel, priya@example.ca, Peer Educator\nSam Lee"} required />
            <div className="actions">
              <button type="button" className="btn ghost" onClick={() => setImporting(false)}>Cancel</button>
              <button className="btn primary">Import</button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Locations

function LocationsTab({ team, onChange }: { team: AdminTeam; onChange: () => void }) {
  const [locs, setLocs] = useState<Locations>({ campuses: [], buildings: [] });
  const [error, setError] = useState("");
  const [campusName, setCampusName] = useState("");
  const [bld, setBld] = useState({ name: "", code: "", campusId: "" });
  const load = useCallback(() => {
    api<Locations>(`/admin/teams/${team.id}/locations`).then(setLocs).catch((e) => setError(errorText(e)));
  }, [team.id]);
  useEffect(load, [load]);
  const run = async (p: Promise<Locations>) => {
    setError("");
    try {
      setLocs(await p);
      onChange();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const order = (kind: "campuses" | "buildings") => async (ids: number[]) => {
    try {
      await api(`/admin/teams/${team.id}/order/${kind}`, { body: { ids } });
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="locations">
      <p className="muted">
        The campuses and buildings you pick from in the room form. Renaming one here updates every room that uses it. Drag to change the order
        they appear in the room form.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="loc-grid">
        <div className="card">
          <h2>Campuses</h2>
          <SortableList
            className="loc-list"
            items={locs.campuses}
            label={(c) => c.name}
            onReorder={order("campuses")}
            render={(c) => (
              <LocRow
                key={`${c.id}-${c.name}`}
                name={c.name}
                count={c.roomCount}
                onRename={(name) => run(api(`/admin/campuses/${c.id}`, { method: "PATCH", body: { name } }))}
                onDelete={() => confirm(`Remove campus ${c.name}?`) && run(api(`/admin/campuses/${c.id}`, { method: "DELETE" }))}
              />
            )}
          />
          {!locs.campuses.length && <p className="muted">No campuses yet.</p>}
          <form className="row wrap add-row" onSubmit={(e) => { e.preventDefault(); run(api(`/admin/teams/${team.id}/campuses`, { body: { name: campusName } })).then(() => setCampusName("")); }}>
            <input aria-label="New campus name" placeholder="e.g. North Oshawa" value={campusName} onChange={(e) => setCampusName(e.target.value)} required maxLength={120} />
            <button className="btn">Add campus</button>
          </form>
        </div>

        <div className="card">
          <h2>Buildings</h2>
          <SortableList
            className="loc-list"
            items={locs.buildings}
            label={(b) => b.name}
            onReorder={order("buildings")}
            render={(b) => (
              <BuildingRow
                key={`${b.id}-${b.name}-${b.code}-${b.campusId}`}
                b={b}
                campuses={locs.campuses}
                onSave={(v) => run(api(`/admin/buildings/${b.id}`, { method: "PATCH", body: v }))}
                onDelete={() => confirm(`Remove building ${b.name}?`) && run(api(`/admin/buildings/${b.id}`, { method: "DELETE" }))}
              />
            )}
          />
          {!locs.buildings.length && <p className="muted">No buildings yet.</p>}
          <form
            className="row wrap add-row"
            onSubmit={(e) => {
              e.preventDefault();
              run(api(`/admin/teams/${team.id}/buildings`, { body: { ...bld, campusId: bld.campusId ? Number(bld.campusId) : null } })).then(() => setBld({ name: "", code: "", campusId: bld.campusId }));
            }}
          >
            <input aria-label="New building name" placeholder="Building name" value={bld.name} onChange={(e) => setBld({ ...bld, name: e.target.value })} required maxLength={120} />
            <input aria-label="Building code" placeholder="Code (e.g. BIT)" value={bld.code} onChange={(e) => setBld({ ...bld, code: e.target.value })} maxLength={20} style={{ width: "9rem" }} />
            <select aria-label="Campus for new building" value={bld.campusId} onChange={(e) => setBld({ ...bld, campusId: e.target.value })}>
              <option value="">No campus</option>
              {locs.campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="btn">Add building</button>
          </form>
        </div>
      </div>
    </section>
  );
}

function LocRow({ name, count, onRename, onDelete }: { name: string; count: number; onRename: (n: string) => void; onDelete: () => void }) {
  const [v, setV] = useState(name);
  return (
    <div className="loc-row">
      <input aria-label="Campus name" value={v} onChange={(e) => setV(e.target.value)} maxLength={120} />
      <span className="muted small-text">{count} {count === 1 ? "room" : "rooms"}</span>
      {v.trim() && v !== name && <button className="btn small primary" onClick={() => onRename(v.trim())}>Save</button>}
      <button className="btn small ghost danger" onClick={onDelete} disabled={count > 0} title={count ? "Move its rooms first" : undefined}>Remove</button>
    </div>
  );
}

function BuildingRow({
  b,
  campuses,
  onSave,
  onDelete,
}: {
  b: Locations["buildings"][number];
  campuses: Locations["campuses"];
  onSave: (v: { name: string; code: string; campusId: number | null }) => void;
  onDelete: () => void;
}) {
  const [d, setD] = useState({ name: b.name, code: b.code, campusId: b.campusId });
  const dirty = d.name !== b.name || d.code !== b.code || d.campusId !== b.campusId;
  return (
    <div className="loc-row building">
      <input aria-label="Building name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} maxLength={120} />
      <input aria-label="Building code" value={d.code} placeholder="Code" onChange={(e) => setD({ ...d, code: e.target.value })} maxLength={20} className="code" />
      <select aria-label="Campus" value={d.campusId ?? ""} onChange={(e) => setD({ ...d, campusId: e.target.value ? Number(e.target.value) : null })}>
        <option value="">No campus</option>
        {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <span className="muted small-text">{b.roomCount} {b.roomCount === 1 ? "room" : "rooms"}</span>
      {dirty && d.name.trim() && <button className="btn small primary" onClick={() => onSave({ ...d, name: d.name.trim() })}>Save</button>}
      <button className="btn small ghost danger" onClick={onDelete} disabled={b.roomCount > 0} title={b.roomCount ? "Move its rooms first" : undefined}>Remove</button>
    </div>
  );
}
