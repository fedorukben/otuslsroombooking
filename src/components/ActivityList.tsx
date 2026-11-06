import { DateTime } from "luxon";
import { useCallback, useEffect, useState } from "react";
import type { ActivityEntry } from "../../shared/types";
import { api, errorText } from "../api";

const TYPES: [string, string][] = [
  ["", "Everything"],
  ["booking", "Bookings"],
  ["room", "Rooms"],
  ["category", "Categories"],
  ["closure", "Closures"],
  ["team", "Team settings"],
  ["admin", "Admins & sign-ins"],
];

const LABEL: Record<string, string> = {
  "booking.create": "Booked",
  "booking.update": "Changed",
  "booking.cancel": "Cancelled",
  "booking.approve": "Approved",
  "booking.reject": "Declined",
  "room.create": "Room added",
  "room.update": "Room changed",
  "room.delete": "Room deleted",
  "category.create": "Category",
  "category.update": "Category",
  "category.delete": "Category",
  "closure.create": "Closure",
  "closure.delete": "Closure",
  "team.create": "Team",
  "team.update": "Settings",
  "team.delete": "Team deleted",
  "team.link_regenerated": "Link reset",
  "admin.login": "Sign-in",
  "admin.login_failed": "Failed sign-in",
  "admin.setup": "Setup",
  "admin.add": "Admin added",
  "admin.remove": "Admin removed",
  "admin.teams": "Admin teams",
  "admin.password": "Password",
};

/** Activity log with filters. With teamId: one team. Without: everything (super admin). */
export function ActivityList({ teamId, zone = "America/Toronto", showTeam = false }: { teamId?: number; zone?: string; showTeam?: boolean }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [more, setMore] = useState(false);
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (before?: number) => {
      setLoading(true);
      const p = new URLSearchParams();
      if (teamId) p.set("teamId", String(teamId));
      if (type) p.set("type", type);
      if (query) p.set("q", query);
      if (before) p.set("before", String(before));
      try {
        const r = await api<{ entries: ActivityEntry[]; more: boolean }>(`/admin/activity?${p}`);
        setEntries((prev) => (before ? [...prev, ...r.entries] : r.entries));
        setMore(r.more);
        setError("");
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoading(false);
      }
    },
    [teamId, type, query],
  );
  useEffect(() => {
    load();
  }, [load]);

  let lastDay = "";
  return (
    <section className="activity">
      <form
        className="row wrap activity-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(search.trim());
        }}
      >
        <select aria-label="Type of activity" value={type} onChange={(e) => setType(e.target.value)}>
          {TYPES.filter(([v]) => showTeam || v !== "admin").map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input type="search" aria-label="Search activity" placeholder="Search names, titles, rooms…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn">Search</button>
        {query && (
          <button type="button" className="link-btn" onClick={() => { setSearch(""); setQuery(""); }}>
            Clear
          </button>
        )}
      </form>
      {error && <p className="error">{error}</p>}
      {!entries.length && !loading && <p className="muted">No activity yet.</p>}
      <ol className="activity-list">
        {entries.map((e) => {
          const t = DateTime.fromISO(e.createdAt).setZone(zone);
          const day = t.toFormat("cccc, LLLL d, yyyy");
          const header = day !== lastDay ? day : null;
          lastDay = day;
          return (
            <li key={e.id}>
              {header && <h3 className="activity-day">{header}</h3>}
              <div className={`activity-row ${e.action.replace(".", "-")}`}>
                <time className="mono" dateTime={e.createdAt}>
                  {t.toFormat("h:mm a")}
                </time>
                <span className={`act-tag ${e.action.split(".")[0]} ${e.action.endsWith("failed") || e.action.endsWith("delete") || e.action.endsWith("cancel") || e.action.endsWith("reject") ? "neg" : ""}`}>
                  {LABEL[e.action] ?? e.action}
                </span>
                <span className="act-summary">
                  {e.summary}
                  <span className="act-meta">
                    {" "}
                    — {e.actorName || "someone"}
                    {e.actorType === "member" ? " (staff)" : e.actorType === "admin" ? " (admin)" : ""}
                    {showTeam && e.teamName ? ` · ${e.teamName}` : ""}
                    {e.ip ? ` · ${e.ip}` : ""}
                  </span>
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      {more && (
        <button className="btn" disabled={loading} onClick={() => load(entries[entries.length - 1]?.id)}>
          {loading ? "Loading…" : "Load older"}
        </button>
      )}
    </section>
  );
}
