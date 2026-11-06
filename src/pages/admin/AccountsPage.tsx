import { useCallback, useEffect, useState } from "react";
import type { AdminAccount, AdminTeam, PendingLink } from "../../../shared/types";
import { api, errorText } from "../../api";
import { Modal } from "../../components/Modal";
import { CopyLink } from "../../components/Scheduler";
import { useAdmin } from "./AdminShell";

export function AccountsPage() {
  const { me, transfer, refresh } = useAdmin();
  const [admins, setAdmins] = useState<AdminAccount[]>([]);
  const [teams, setTeams] = useState<AdminTeam[]>([]);
  const [links, setLinks] = useState<PendingLink[]>([]);
  const [invite, setInvite] = useState({ name: "", email: "", teamIds: [] as number[] });
  const [newLink, setNewLink] = useState<{ title: string; link: string; expiresAt: string; note: string } | null>(null);
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "" });
  const [editing, setEditing] = useState<AdminAccount | null>(null);
  const [handover, setHandover] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<{ teams: AdminTeam[] }>("/admin/teams").then((r) => setTeams(r.teams)).catch((e) => setError(errorText(e)));
    if (me.isSuper) {
      api<{ admins: AdminAccount[] }>("/admin/admins").then((r) => setAdmins(r.admins)).catch((e) => setError(errorText(e)));
      api<{ links: PendingLink[] }>("/admin/links").then((r) => setLinks(r.links)).catch(() => undefined);
    }
  }, [me.isSuper]);
  useEffect(load, [load]);

  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const fail = (e: unknown) => setError(errorText(e));

  const passwordCard = (
    <form
      className="card stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        try {
          await api("/admin/password", { body: pw });
          setPw({ currentPassword: "", newPassword: "" });
          setMsg("Your password was changed. Any other signed-in sessions were signed out.");
        } catch (err) {
          fail(err);
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
          <p>You manage: {teams.length ? teams.map((t) => t.name).join(", ") : "no teams yet"}. Ask the super admin to give you access to other teams.</p>
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
                <td className="small-text">{a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : "Never"}</td>
                <td className="right">
                  {!a.isSuper && (
                    <>
                      <button className="btn small" onClick={() => setEditing(a)}>Teams</button>{" "}
                      <button
                        className="btn small"
                        onClick={async () => {
                          try {
                            const r = await api<{ path: string; expiresAt: string }>(`/admin/admins/${a.id}/reset-link`, { body: {} });
                            setNewLink({ title: `Password reset link for ${a.name}`, link: location.origin + r.path, expiresAt: r.expiresAt, note: `Send this to ${a.name}. It lets them choose a new password, works once, and expires in 24 hours. Their current password keeps working until they use it.` });
                            load();
                          } catch (e) {
                            fail(e);
                          }
                        }}
                      >
                        Reset password
                      </button>{" "}
                      <button
                        className="btn small ghost danger"
                        onClick={async () => {
                          if (!confirm(`Remove ${a.name}'s admin access?`)) return;
                          await api(`/admin/admins/${a.id}`, { method: "DELETE" }).catch(fail);
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
            const r = await api<{ path: string; expiresAt: string }>("/admin/invites", { body: invite });
            setNewLink({
              title: `Invite link for ${invite.name}`,
              link: location.origin + r.path,
              expiresAt: r.expiresAt,
              note: `Send this to ${invite.name}. They'll choose their own password and be signed straight in. It works once and expires in 7 days.`,
            });
            setInvite({ name: "", email: "", teamIds: [] });
            load();
          } catch (err) {
            fail(err);
          }
        }}
      >
        <h2>Invite an admin</h2>
        <p className="hint">You'll get a link to send them (email, Teams, etc.). They set their own password; you never see it.</p>
        <div className="grid-2">
          <label className="field"><span>Name</span><input value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} required /></label>
          <label className="field"><span>Email (they'll sign in with this)</span><input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} required /></label>
        </div>
        <fieldset>
          <legend>Teams they'll manage</legend>
          <TeamChecks value={invite.teamIds} onChange={(v) => setInvite({ ...invite, teamIds: v })} />
        </fieldset>
        <div className="actions"><button className="btn primary">Create invite link</button></div>
      </form>

      {links.length > 0 && (
        <section className="card">
          <h2>Open links</h2>
          <p className="hint">Links you've made that haven't been used yet. For security the link itself is only shown once; cancel and make a new one if it's lost.</p>
          <ul className="link-list">
            {links.map((l) => (
              <li key={l.id}>
                <span className="badge">{l.kind === "invite" ? "Invite" : "Reset"}</span>
                <span>
                  <strong>{l.name}</strong> · {l.email}
                </span>
                <span className="muted small-text">expires {new Date(l.expiresAt).toLocaleString()}</span>
                <button
                  className="btn small ghost danger"
                  onClick={async () => {
                    await api(`/admin/links/${l.id}`, { method: "DELETE" }).catch(fail);
                    load();
                  }}
                >
                  Cancel link
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {passwordCard}

      <section className="card stack danger-zone" id="handover">
        <h2>Hand over super admin</h2>
        {transfer?.direction === "out" ? (
          <>
            <p>
              <strong>Waiting for {transfer.toName}</strong> ({transfer.toEmail}) to accept. Until they do, nothing has changed and you're still
              the super admin. The offer expires {new Date(transfer.expiresAt).toLocaleString()}.
            </p>
            <p className="hint">
              If they accept you'll keep: {transfer.keepTeamIds.map((id) => teamName.get(id)).filter(Boolean).join(", ") || "no teams"}.
            </p>
            <div>
              <button
                className="btn"
                onClick={async () => {
                  await api("/admin/super-transfer", { method: "DELETE" }).catch(fail);
                  setMsg("Handover cancelled. You're still the super admin.");
                  refresh();
                }}
              >
                Cancel handover
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Make another admin the super admin and step down to a regular admin. This takes several confirmations, and nothing happens until
              the other admin accepts.
            </p>
            <div>
              <button className="btn ghost danger" onClick={() => setHandover(true)}>
                Start handover…
              </button>
            </div>
          </>
        )}
      </section>

      {newLink && (
        <Modal title={newLink.title} onClose={() => setNewLink(null)}>
          <div className="stack">
            <p>{newLink.note}</p>
            <CopyLink url={newLink.link} />
            <p className="warn-text small-text">Copy it now. For security it won't be shown again.</p>
            <div className="actions"><button className="btn primary" onClick={() => setNewLink(null)}>Done</button></div>
          </div>
        </Modal>
      )}

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
                fail(err);
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

      {handover && (
        <HandoverWizard
          admins={admins.filter((a) => !a.isSuper)}
          teams={teams}
          onClose={() => setHandover(false)}
          onDone={() => {
            setHandover(false);
            setMsg("Handover offer sent. You're still the super admin until they accept.");
            refresh();
          }}
        />
      )}
    </main>
  );
}

const PHRASE = "TRANSFER SUPER ADMIN";

function HandoverWizard({ admins, teams, onClose, onDone }: { admins: AdminAccount[]; teams: AdminTeam[]; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState(1);
  const [acks, setAcks] = useState([false, false, false, false]);
  const [targetId, setTargetId] = useState<number>(0);
  const [keep, setKeep] = useState<number[]>(teams.map((t) => t.id));
  const [email, setEmail] = useState("");
  const [phrase, setPhrase] = useState("");
  const [password, setPassword] = useState("");
  const [countdown, setCountdown] = useState(5);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const target = admins.find((a) => a.id === targetId);

  useEffect(() => {
    if (step !== 3) return;
    setCountdown(5);
    const t = setInterval(() => setCountdown((c) => (c > 0 ? c - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [step]);

  const ackText = [
    "I will no longer be able to add, remove or reset other admins, delete teams, or see the all-teams activity log.",
    "I will only be able to manage the teams I choose to keep in the next step. Only the new super admin can give me more.",
    "I can't undo this myself. Only the new super admin can hand the role back to me.",
    "The new super admin will be able to see every team's bookings, including private ones, and could remove my access entirely.",
  ];

  const ready = target && email.trim().toLowerCase() === target.email && phrase.trim() === PHRASE && password.length > 0 && countdown === 0;

  return (
    <Modal title={`Hand over super admin · step ${step} of 3`} onClose={onClose} wide>
      <div className="stack">
        {step === 1 && (
          <>
            <p className="lede">Read each point and tick it to show you understand. Nothing changes yet.</p>
            {ackText.map((t, i) => (
              <label className="check ack" key={i}>
                <input type="checkbox" checked={acks[i]} onChange={(e) => setAcks(acks.map((v, k) => (k === i ? e.target.checked : v)))} />
                {t}
              </label>
            ))}
            <div className="actions">
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={!acks.every(Boolean)} onClick={() => setStep(2)}>Continue</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <label className="field">
              <span>Who should become the super admin?</span>
              <select value={targetId || ""} onChange={(e) => setTargetId(Number(e.target.value))}>
                <option value="" disabled>Choose an admin…</option>
                {admins.map((a) => (
                  <option key={a.id} value={a.id} disabled={!a.lastLoginAt}>
                    {a.name} ({a.email}){a.lastLoginAt ? "" : " — has never signed in"}
                  </option>
                ))}
              </select>
              <small className="hint">Only admins who have signed in at least once can be chosen, so you know their account works.</small>
            </label>
            {!admins.length && <p className="warn-text">There are no other admins yet. Invite one first.</p>}
            <fieldset>
              <legend>Teams you'll keep managing</legend>
              <p className="hint">After the handover you'll be a regular admin of these teams. Untick any you want to step away from.</p>
              <div className="row wrap">
                {teams.map((t) => (
                  <label className="check" key={t.id}>
                    <input type="checkbox" checked={keep.includes(t.id)} onChange={(e) => setKeep(e.target.checked ? [...keep, t.id] : keep.filter((x) => x !== t.id))} />
                    {t.name}
                  </label>
                ))}
              </div>
              {teams.length > 0 && !keep.length && <p className="warn-text">You'll have no teams at all after the handover.</p>}
            </fieldset>
            <div className="actions">
              <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
              <button className="btn primary" disabled={!target} onClick={() => setStep(3)}>Continue</button>
            </div>
          </>
        )}

        {step === 3 && target && (
          <>
            <div className="handover-summary">
              <p>
                <strong>{target.name}</strong> ({target.email}) will be offered the super admin role.
              </p>
              <p>
                If they accept, you become a regular admin of:{" "}
                <strong>{keep.map((id) => teams.find((t) => t.id === id)?.name).filter(Boolean).join(", ") || "no teams"}</strong>.
              </p>
              <p className="hint">They have 72 hours to accept. You stay the super admin, and can cancel, until they do.</p>
            </div>
            <label className="field">
              <span>Type {target.name}'s email address</span>
              <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            <label className="field">
              <span>Type <code>{PHRASE}</code></span>
              <input value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            <label className="field">
              <span>Your password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="actions">
              <button className="btn ghost" onClick={() => setStep(2)}>Back</button>
              <button
                className="btn danger"
                disabled={!ready || busy}
                onClick={async () => {
                  if (!confirm(`Last check: offer the super admin role to ${target.name}? You'll lose it the moment they accept.`)) return;
                  setBusy(true);
                  try {
                    await api("/admin/super-transfer", {
                      body: { targetId: target.id, confirmEmail: email, phrase, password, keepTeamIds: keep, understood: true },
                    });
                    onDone();
                  } catch (e) {
                    setError(errorText(e));
                    setBusy(false);
                  }
                }}
              >
                {countdown > 0 ? `Read the summary (${countdown})` : "Send handover offer"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
