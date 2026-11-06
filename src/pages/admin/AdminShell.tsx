import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { api, errorText } from "../../api";
import { Modal } from "../../components/Modal";
import { LogoMark, Wordmark } from "../../components/AppLogo";
import type { TransferOffer } from "../../../shared/types";

type Transfer = (TransferOffer & { direction: "in" | "out" }) | null;

interface Me {
  id: number;
  email: string;
  name: string;
  isSuper: boolean;
}

const AdminCtx = createContext<{ me: Me; signOut: () => void; transfer: Transfer; refresh: () => void } | null>(null);
export const useAdmin = () => useContext(AdminCtx)!;

/** Shows first-run setup or sign-in until there's an admin session, then renders the admin area. */
export function AdminShell({ children, bare = false }: { children: ReactNode; bare?: boolean }) {
  const [status, setStatus] = useState<{ needsSetup: boolean; setupKeyConfigured: boolean; admin: Me | null; transfer: Transfer } | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const refresh = useCallback(() => {
    api("/admin/status")
      .then(setStatus)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(refresh, [refresh]);

  const signOut = async () => {
    await api("/admin/logout", { body: {} }).catch(() => undefined);
    navigate("/admin");
    refresh();
  };

  if (error) return <main className="center-page"><div className="card narrow"><h1>Can't reach the server</h1><p>{error}</p></div></main>;
  if (!status) return <main className="center-page"><p className="muted">Loading…</p></main>;
  if (status.needsSetup) return <Setup keyConfigured={status.setupKeyConfigured} onDone={refresh} />;
  if (!status.admin) return <Login onDone={refresh} />;

  return (
    <AdminCtx.Provider value={{ me: status.admin, signOut, transfer: status.transfer, refresh }}>
      <div className="admin-shell">
        {!bare && <header className="admin-bar">
          <Link to="/admin" className="wordmark">
            <Wordmark size={30} bare sub="admin" />
          </Link>
          <nav aria-label="Admin">
            <Link to="/" className="back-dash">← Dashboard</Link>
            <NavLink to="/admin" end>
              Teams
            </NavLink>
            {status.admin.isSuper && <NavLink to="/admin/activity">Activity</NavLink>}
            <NavLink to="/admin/accounts">{status.admin.isSuper ? "Admin accounts" : "My account"}</NavLink>
          </nav>
          <div className="admin-user">
            <span>
              {status.admin.name}
              {status.admin.isSuper && <span className="badge super">Super admin</span>}
            </span>
            <button className="btn ghost small" onClick={signOut}>
              Sign out
            </button>
          </div>
        </header>}
        {!bare && status.transfer?.direction === "in" && (
          <div className="transfer-banner" role="status">
            <span>
              <strong>{status.transfer.fromName}</strong> wants to make you the <strong>super admin</strong>. Nothing changes unless you accept.
            </span>
            <button className="btn small" onClick={() => setAccepting(true)}>Review</button>
          </div>
        )}
        {!bare && status.transfer?.direction === "out" && (
          <div className="transfer-banner out" role="status">
            <span>
              Super admin handover to <strong>{status.transfer.toName}</strong> is waiting for them to accept. You're still the super admin until they do.
            </span>
            <Link className="btn small" to="/admin/accounts#handover">Manage</Link>
          </div>
        )}
        {accepting && status.transfer?.direction === "in" && (
          <AcceptTransfer transfer={status.transfer} onClose={() => setAccepting(false)} onDone={() => { setAccepting(false); refresh(); navigate("/admin"); }} />
        )}
        {children}
      </div>
    </AdminCtx.Provider>
  );
}

function AuthCard({ title, children, onSubmit }: { title: string; children: ReactNode; onSubmit: (e: FormEvent) => void }) {
  return (
    <main className="center-page auth">
      <form className="card narrow" onSubmit={onSubmit}>
        <div className="card-brand"><LogoMark size={40} /><p className="eyebrow">Room Scheduler</p></div>
        <h1>{title}</h1>
        {children}
      </form>
    </main>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <AuthCard
      title="Admin sign-in"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api("/admin/login", { body: { email, password } });
          onDone();
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span>Email</span>
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      </label>
      <label className="field">
        <span>Password</span>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn primary block" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <details className="forgot">
        <summary>Forgot your password?</summary>
        <p>Ask the super admin for a password reset link. It lets you choose a new password and works for 24 hours.</p>
        <p>
          If <em>you</em> are the super admin, use <Link to="/admin/recover">super admin recovery</Link> with the setup key from Netlify.
        </p>
      </details>
    </AuthCard>
  );
}

function Setup({ keyConfigured, onDone }: { keyConfigured: boolean; onDone: () => void }) {
  const [f, setF] = useState({ setupKey: "", name: "", email: "", password: "" });
  const [error, setError] = useState("");
  if (!keyConfigured) {
    return (
      <main className="center-page">
        <div className="card narrow">
          <p className="eyebrow">First-time setup</p>
          <h1>One step before you start</h1>
          <p>
            In Netlify, open <strong>Project configuration → Environment variables</strong>, add <code>ADMIN_SETUP_KEY</code> with any long secret
            phrase, then redeploy. Come back here and use that phrase to create the first admin account.
          </p>
        </div>
      </main>
    );
  }
  return (
    <AuthCard
      title="Create the first admin"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api("/admin/setup", { body: f });
          onDone();
        } catch (err) {
          setError(errorText(err));
        }
      }}
    >
      <p className="hint">Enter the ADMIN_SETUP_KEY you set in Netlify. This only works once, while no admin exists.</p>
      <label className="field">
        <span>Setup key</span>
        <input type="password" value={f.setupKey} onChange={(e) => setF({ ...f, setupKey: e.target.value })} required />
      </label>
      <label className="field">
        <span>Your name</span>
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoComplete="name" />
      </label>
      <label className="field">
        <span>Email</span>
        <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required autoComplete="username" />
      </label>
      <label className="field">
        <span>Password (10+ characters)</span>
        <input type="password" minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required autoComplete="new-password" />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn primary block">Create admin account</button>
    </AuthCard>
  );
}

function AcceptTransfer({ transfer, onClose, onDone }: { transfer: NonNullable<Transfer>; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState("");
  const [ack, setAck] = useState(false);
  const [error, setError] = useState("");
  const PHRASE = "ACCEPT SUPER ADMIN";
  return (
    <Modal title="Become the super admin?" onClose={onClose}>
      <div className="stack">
        <p>
          <strong>{transfer.fromName}</strong> is offering you the super admin role. If you accept:
        </p>
        <ul className="consequences">
          <li>You can see and manage <strong>every team</strong>, add and remove admins, delete teams, and see the all-teams activity log.</li>
          <li>{transfer.fromName} becomes a regular admin. They'll lose those powers right away, and only you can give the role back.</li>
          <li>If you ever forget your password, recovery uses the <code>ADMIN_SETUP_KEY</code> in Netlify, so make sure you can get it.</li>
        </ul>
        <label className="check">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand and want to take this on.
        </label>
        <label className="field">
          <span>Type <code>{PHRASE}</code></span>
          <input value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" />
        </label>
        <label className="field">
          <span>Your password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button
            className="btn ghost danger"
            onClick={async () => {
              if (!confirm("Decline the super admin role?")) return;
              await api("/admin/super-transfer", { method: "DELETE" }).catch(() => undefined);
              onDone();
            }}
          >
            Decline
          </button>
          <button className="btn ghost" onClick={onClose}>Decide later</button>
          <button
            className="btn primary"
            disabled={!ack || phrase.trim() !== PHRASE || !password}
            onClick={async () => {
              try {
                await api("/admin/super-transfer/accept", { body: { password, phrase } });
                onDone();
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            Accept super admin
          </button>
        </div>
      </div>
    </Modal>
  );
}
