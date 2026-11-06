import { useCallback, useEffect, useState } from "react";
import type { AdminAccount, AdminTeam } from "../../../shared/types";
import { api, errorText } from "../../api";
import { Modal } from "../../components/Modal";
import { useAdmin } from "./AdminShell";

export function AccountsPage() {
  const { me } = useAdmin();
  const [admins, setAdmins] = useState<AdminAccount[]>([]);
  const [teams, setTeams] = useState<AdminTeam[]>([]);
  const [f, setF] = useState({ name: "", email: "", password: "", teamIds: [] as number[] });
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "" });
  const [editing, setEditing] = useState<AdminAccount | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<{ teams: AdminTeam[] }>("/admin/teams").then((r) => setTeams(r.teams)).catch((e) => setError(errorText(e)));
    if (me.isSuper) api<{ admins: AdminAccount[] }>("/admin/admins").then((r) => setAdmins(r.admins)).catch((e) => setError(errorText(e)));
  }, [me.isSuper]);
  useEffect(load, [load]);

  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  const passwordCard = (
    <form
      className="card stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        try {
          await api("/admin/password", { body: pw });
          setPw({ currentPassword: "", newPassword: "" });
          setMsg("Your password was changed.");
        } catch (err) {
          setError(errorText(err));
        }
      }}
    >
      <h2>Change my password</h2>
      <div className="grid-2">
        <label className="field"><span>Current password</span><input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required autoComplete="current-password" /></label>
        <label className="field"><span>New password (10+ characters)</span><input type="password" minLength={10} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required autoComplete="new-password" /></label>
      </div>
      <div className="actions"><button className="btn primary">Change password</button></div>
    </form>
  );

  if (!me.isSuper) {
    return (
      <main className="page narrow-page">
        <p className="eyebrow">Admin</p>
        <h1>My account</h1>
        {error && <p className="error" role="alert">{error}</p>}
        {msg && <p className="notice" role="status">{msg}</p>}
        <section className="card">
          <p>
            Signed in as <strong>{me.name}</strong> ({me.email}).
          </p>
          <p>
            You manage: {teams.length ? teams.map((t) => t.name).join(", ") : "no teams yet"}. Ask the super admin to give you access to other teams.
          </p>
        </section>
        {passwordCard}
      </main>
    );
  }

  const TeamChecks = ({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) => (
    <div className="row wrap">
      {teams.map((t) => (
        <label className="check" key={t.id}>
          <input type="checkbox" checked={value.includes(t.id)} onChange={(e) => onChange(e.target.checked ? [...value, t.id] : value.filter((x) => x !== t.id))} />
          {t.name}
        </label>
      ))}
      {!teams.length && <span className="muted">No teams yet.</span>}
    </div>
  );

  return (
    <main className="page narrow-page">
      <p className="eyebrow">Super admin</p>
      <h1>Admin accounts</h1>
      <p className="muted">You're the super admin: you can see and manage every team. Other admins only see the teams you give them.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {msg && <p className="notice" role="status">{msg}</p>}
      <section className="card">
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Email</th><th>Teams</th><th>Last sign-in</th><th><span className="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            {admins.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.name}
                  {a.isSuper && <span className="badge super">Super</span>}
                  {a.id === me.id && <span className="badge">You</span>}
                </td>
                <td>{a.email}</td>
                <td className="small-text">{a.isSuper ? "All teams" : a.teamIds.map((id) => teamName.get(id)).filter(Boolean).join(", ") || "—"}</td>
                <td className="small-text">{a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : "—"}</td>
                <td className="right">
                  {!a.isSuper && (
                    <>
                      <button className="btn small" onClick={() => setEditing(a)}>Teams</button>{" "}
                      <button
                        className="btn small ghost danger"
                        onClick={async () => {
                          if (!confirm(`Remove ${a.name}'s admin access?`)) return;
                          await api(`/admin/admins/${a.id}`, { method: "DELETE" });
                          load();
                        }}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await api("/admin/admins", { body: f });
            setF({ name: "", email: "", password: "", teamIds: [] });
            setMsg("Admin added. Share the password with them securely; they can change it after signing in.");
            load();
          } catch (err) {
            setError(errorText(err));
          }
        }}
      >
        <h2>Add an admin</h2>
        <div className="grid-3">
          <label className="field"><span>Name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
          <label className="field"><span>Email</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
          <label className="field"><span>Temporary password</span><input type="password" minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required autoComplete="new-password" /></label>
        </div>
        <fieldset>
          <legend>Teams they manage</legend>
          <TeamChecks value={f.teamIds} onChange={(v) => setF({ ...f, teamIds: v })} />
        </fieldset>
        <div className="actions"><button className="btn primary">Add admin</button></div>
      </form>

      {passwordCard}

      {editing && (
        <Modal title={`Teams for ${editing.name}`} onClose={() => setEditing(null)}>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api(`/admin/admins/${editing.id}/teams`, { method: "PATCH", body: { teamIds: editing.teamIds } });
                setEditing(null);
                setMsg("Team access updated.");
                load();
              } catch (err) {
                setError(errorText(err));
              }
            }}
          >
            <TeamChecks value={editing.teamIds} onChange={(v) => setEditing({ ...editing, teamIds: v })} />
            <div className="actions">
              <button type="button" className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn primary">Save</button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}
