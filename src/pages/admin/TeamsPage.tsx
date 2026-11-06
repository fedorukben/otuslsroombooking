import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { AdminTeam } from "../../../shared/types";
import { api, errorText } from "../../api";
import { Modal } from "../../components/Modal";
import { TimezoneSelect } from "./fields";

export function TeamsPage() {
  const [teams, setTeams] = useState<AdminTeam[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [tz, setTz] = useState("America/Toronto");
  const navigate = useNavigate();

  useEffect(() => {
    api<{ teams: AdminTeam[] }>("/admin/teams")
      .then((r) => setTeams(r.teams))
      .catch((e) => setError(errorText(e)));
  }, []);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Teams</h1>
          <p className="muted">Each team has its own rooms, categories, rules and booking link. Teams never see each other.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          + New team
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {teams && !teams.length && (
        <div className="card empty-state">
          <h2>No teams yet</h2>
          <p>Create a team, add its rooms, then share the team's booking link with staff.</p>
          <button className="btn primary" onClick={() => setCreating(true)}>
            Create your first team
          </button>
        </div>
      )}
      <ul className="team-grid">
        {teams?.map((t, i) => (
          <li key={t.id} style={{ ["--accent" as string]: t.accentColor, animationDelay: `${i * 40}ms` }}>
            <Link to={`/admin/teams/${t.id}`} className="team-tile">
              <span className="tile-bar" />
              <h2>{t.name}</h2>
              <p className="muted">{t.description || " "}</p>
              <div className="tile-stats">
                <span>
                  <b>{t.roomCount}</b> {t.roomCount === 1 ? "room" : "rooms"}
                </span>
                {t.pendingCount > 0 && <span className="badge amber">{t.pendingCount} pending</span>}
                {t.hasPin && <span className="badge">PIN</span>}
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {creating && (
        <Modal title="New team" onClose={() => setCreating(false)}>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const r = await api<{ team: AdminTeam }>("/admin/teams", { body: { name, timezone: tz } });
                navigate(`/admin/teams/${r.team.id}?tab=rooms`);
              } catch (err) {
                setError(errorText(err));
                setCreating(false);
              }
            }}
          >
            <label className="field">
              <span>Team name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={120} />
            </label>
            <TimezoneSelect value={tz} onChange={setTz} />
            <p className="hint">You'll get four starter categories (Meeting, Workshop, Event, Other) that you can change.</p>
            <div className="actions">
              <button type="button" className="btn ghost" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="btn primary">Create team</button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}
