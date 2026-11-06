import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { api, errorText } from "../../api";

interface Me {
  id: number;
  email: string;
  name: string;
  isSuper: boolean;
}

const AdminCtx = createContext<{ me: Me; signOut: () => void } | null>(null);
export const useAdmin = () => useContext(AdminCtx)!;

/** Shows first-run setup or sign-in until there's an admin session, then renders the admin area. */
export function AdminShell({ children, bare = false }: { children: ReactNode; bare?: boolean }) {
  const [status, setStatus] = useState<{ needsSetup: boolean; setupKeyConfigured: boolean; admin: Me | null } | null>(null);
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
    <AdminCtx.Provider value={{ me: status.admin, signOut }}>
      <div className="admin-shell">
        {!bare && <header className="admin-bar">
          <Link to="/admin" className="wordmark">
            <span className="mark" aria-hidden />
            Room Scheduler <em>admin</em>
          </Link>
          <nav aria-label="Admin">
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
        {children}
      </div>
    </AdminCtx.Provider>
  );
}

function AuthCard({ title, children, onSubmit }: { title: string; children: ReactNode; onSubmit: (e: FormEvent) => void }) {
  return (
    <main className="center-page auth">
      <form className="card narrow" onSubmit={onSubmit}>
        <p className="eyebrow">Room Scheduler</p>
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
