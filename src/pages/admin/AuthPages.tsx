import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorText } from "../../api";
import { LogoMark } from "../../components/AppLogo";

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="center-page auth">
      <div className="card narrow">
        <div className="card-brand"><LogoMark size={40} /><p className="eyebrow">Room Scheduler</p></div>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

function PasswordPair({ value, onChange }: { value: { a: string; b: string }; onChange: (v: { a: string; b: string }) => void }) {
  return (
    <>
      <label className="field">
        <span>New password (10+ characters)</span>
        <input type="password" minLength={10} autoComplete="new-password" value={value.a} onChange={(e) => onChange({ ...value, a: e.target.value })} required />
      </label>
      <label className="field">
        <span>Type it again</span>
        <input type="password" minLength={10} autoComplete="new-password" value={value.b} onChange={(e) => onChange({ ...value, b: e.target.value })} required />
      </label>
      {value.b && value.a !== value.b && <p className="warn-text">The passwords don't match yet.</p>}
    </>
  );
}

/** /admin/invite/:token — a new admin sets their own password. */
export function InvitePage() {
  const { token = "" } = useParams();
  const [info, setInfo] = useState<{ name: string; email: string; teams: string[]; expiresAt: string } | null>(null);
  const [name, setName] = useState("");
  const [pw, setPw] = useState({ a: "", b: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/admin/invite/${token}`)
      .then((r) => {
        setInfo(r);
        setName(r.name);
      })
      .catch((e) => setError(errorText(e)));
  }, [token]);

  if (!info) return <Shell title="Admin invite">{error ? <p className="error">{error}</p> : <p className="muted">Checking your invite…</p>}</Shell>;

  return (
    <Shell title="Set up your admin account">
      <form
        className="stack"
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          if (pw.a !== pw.b) return setError("The passwords don't match.");
          setBusy(true);
          try {
            await api(`/admin/invite/${token}`, { body: { password: pw.a, name } });
            window.location.href = "/";
          } catch (err) {
            setError(errorText(err));
            setBusy(false);
          }
        }}
      >
        <p>
          You've been invited as an admin{info.teams.length ? <> for <strong>{info.teams.join(", ")}</strong></> : null}. You'll sign in with{" "}
          <strong>{info.email}</strong>.
        </p>
        <label className="field">
          <span>Your name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="name" />
        </label>
        <PasswordPair value={pw} onChange={setPw} />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary block" disabled={busy || pw.a.length < 10 || pw.a !== pw.b}>
          {busy ? "Creating…" : "Create my account"}
        </button>
        <p className="hint">This link works once and expires {new Date(info.expiresAt).toLocaleString()}.</p>
      </form>
    </Shell>
  );
}

/** /admin/reset/:token — set a new password from a link the super admin made. */
export function ResetPage() {
  const { token = "" } = useParams();
  const [info, setInfo] = useState<{ name: string; email: string; expiresAt: string } | null>(null);
  const [pw, setPw] = useState({ a: "", b: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/admin/reset/${token}`).then(setInfo).catch((e) => setError(errorText(e)));
  }, [token]);
  if (!info) return <Shell title="Reset password">{error ? <p className="error">{error}</p> : <p className="muted">Checking your link…</p>}</Shell>;
  return (
    <Shell title="Choose a new password">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pw.a !== pw.b) return setError("The passwords don't match.");
          setBusy(true);
          try {
            await api(`/admin/reset/${token}`, { body: { password: pw.a } });
            window.location.href = "/";
          } catch (err) {
            setError(errorText(err));
            setBusy(false);
          }
        }}
      >
        <p>
          For <strong>{info.name}</strong> ({info.email}). Any other signed-in sessions will be signed out.
        </p>
        <PasswordPair value={pw} onChange={setPw} />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary block" disabled={busy || pw.a.length < 10 || pw.a !== pw.b}>
          {busy ? "Saving…" : "Save new password"}
        </button>
      </form>
    </Shell>
  );
}

/** /admin/recover — the super admin's own password, using ADMIN_SETUP_KEY. */
export function RecoverPage() {
  const [f, setF] = useState({ setupKey: "", email: "" });
  const [pw, setPw] = useState({ a: "", b: "" });
  const [error, setError] = useState("");
  return (
    <Shell title="Super admin recovery">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pw.a !== pw.b) return setError("The passwords don't match.");
          try {
            await api("/admin/recover", { body: { ...f, newPassword: pw.a } });
            window.location.href = "/admin";
          } catch (err) {
            setError(errorText(err));
          }
        }}
      >
        <p>
          For the super admin only. You'll need the <code>ADMIN_SETUP_KEY</code> value from Netlify (Project configuration → Environment variables).
          Other admins: ask the super admin for a reset link.
        </p>
        <label className="field">
          <span>Setup key</span>
          <input type="password" value={f.setupKey} onChange={(e) => setF({ ...f, setupKey: e.target.value })} required autoComplete="off" />
        </label>
        <label className="field">
          <span>Super admin email</span>
          <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required autoComplete="username" />
        </label>
        <PasswordPair value={pw} onChange={setPw} />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary block" disabled={pw.a.length < 10 || pw.a !== pw.b}>
          Reset my password
        </button>
        <p className="hint">
          <Link to="/admin">Back to sign-in</Link>
        </p>
      </form>
    </Shell>
  );
}

/** /invite/:token — staff member sets a password so they can sign in and book. */
export function StaffInvitePage() {
  const { token = "" } = useParams();
  const [info, setInfo] = useState<{ name: string; email: string; teamName: string; expiresAt: string } | null>(null);
  const [pw, setPw] = useState({ a: "", b: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/invite/${token}`).then(setInfo).catch((e) => setError(errorText(e)));
  }, [token]);
  if (!info) return <Shell title="Room booking invite">{error ? <p className="error">{error}</p> : <p className="muted">Checking your invite…</p>}</Shell>;
  return (
    <Shell title={`Welcome, ${info.name.split(" ")[0]}`}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pw.a !== pw.b) return setError("The passwords don't match.");
          setBusy(true);
          try {
            await api(`/invite/${token}`, { body: { password: pw.a } });
            window.location.href = "/";
          } catch (err) {
            setError(errorText(err));
            setBusy(false);
          }
        }}
      >
        <p>
          Set a password to book rooms for <strong>{info.teamName}</strong>. You'll sign in with <strong>{info.email}</strong>.
        </p>
        <PasswordPair value={pw} onChange={setPw} />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary block" disabled={busy || pw.a.length < 10 || pw.a !== pw.b}>
          {busy ? "Setting up…" : "Set password and sign in"}
        </button>
        <p className="hint">This link works once and expires {new Date(info.expiresAt).toLocaleString()}.</p>
      </form>
    </Shell>
  );
}
