import { DateTime } from "luxon";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { CalendarBooking, MyBooking, MyTeam } from "../../shared/types";
import { adminEndpoints, api, ApiError, errorText, staffEndpoints } from "../api";
import { Modal } from "../components/Modal";
import { LogoMark } from "../components/AppLogo";
import { fmtTime, onColor } from "../lib/time";

export const CAMPUS_MAP_URL = "https://ontariotechu.ca/map/";

interface Account {
  id: number;
  name: string;
  email: string;
  isAdmin: boolean;
  isSuper: boolean;
}

/** "/" — sign-in for everyone, then the dashboard. */
export function Home() {
  const [state, setState] = useState<{ account: Account; teams: MyTeam[] } | null | "out">(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api("/me")
      .then(setState)
      .catch((e) => (e instanceof ApiError && e.status === 401 ? setState("out") : setError(errorText(e))));
  }, []);
  useEffect(load, [load]);
  if (error) return <main className="center-page"><div className="card narrow"><h1>Can't reach the server</h1><p>{error}</p></div></main>;
  if (state === null) return <main className="center-page"><p className="muted">Loading…</p></main>;
  if (state === "out") return <SignIn onDone={load} />;
  return <Dashboard account={state.account} teams={state.teams} />;
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/admin/login", { body: { email, password } });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  return (
    <main className="signin-page">
      <section className="signin-hero">
        <div className="hero-brand"><LogoMark size={64} /><p className="eyebrow">Room Scheduler</p></div>
        <h1>
          Book the room.
          <br />
          <span>Skip the email chain.</span>
        </h1>
        <p className="lede">{DateTime.now().toFormat("cccc, LLLL d")}</p>
      </section>
      <form className="card signin-card" onSubmit={submit}>
        <h2>Sign in</h2>
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary block" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <details className="forgot">
          <summary>Forgot your password or don't have one?</summary>
          <p>Ask a team admin. They can send you an invite or a password reset link from their People tab.</p>
          <p>If your team gave you a booking link instead, you can keep using it.</p>
        </details>
      </form>
    </main>
  );
}

function greeting() {
  const h = DateTime.now().hour;
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function Dashboard({ account, teams }: { account: Account; teams: MyTeam[] }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const teamId = Number(params.get("team")) || teams[0]?.id || 0;
  const team = teams.find((t) => t.id === teamId) ?? teams[0];
  const [mine, setMine] = useState<MyBooking[]>([]);
  const [pwOpen, setPwOpen] = useState(false);
  const zone = team?.timezone ?? "America/Toronto";
  const [now, setNow] = useState(DateTime.now().setZone(zone));

  useEffect(() => {
    const t = setInterval(() => setNow(DateTime.now().setZone(zone)), 30_000);
    return () => clearInterval(t);
  }, [zone]);
  useEffect(() => {
    api<{ bookings: MyBooking[] }>("/me/bookings").then((r) => setMine(r.bookings)).catch(() => undefined);
  }, []);

  const signOut = async () => {
    await api("/admin/logout", { body: {} }).catch(() => undefined);
    window.location.href = "/";
  };
  const style = team ? { ["--accent" as string]: team.accentColor, ["--on-accent" as string]: onColor(team.accentColor) } : undefined;
  const teamPath = team ? `/teams/${team.id}` : "";

  return (
    <div className="dash-shell" style={style}>
      <header className="dash-top">
        <Link to={team ? `/?team=${team.id}` : "/"} className="dash-brand" aria-label={team ? `${team.name} — dashboard` : "Dashboard"}>
          {team?.logoDataUrl ? (
            <img src={team.logoDataUrl} alt={team.name} className="dash-logo" />
          ) : (
            <>
              <LogoMark size={40} />
              <span className="dash-brand-name">{team?.name ?? "Room Scheduler"}</span>
            </>
          )}
        </Link>
        <div className="dash-user">
          {account.isAdmin && (
            <Link className="btn small ghost" to="/admin">
              Admin area
            </Link>
          )}
          <button className="btn small ghost" onClick={() => setPwOpen(true)}>Change password</button>
          <button className="btn small ghost" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <main className="page dash">
        <section className="dash-hello">
          <div>
            <p className="eyebrow">{greeting()}, {account.name.split(" ")[0]}</p>
            <h1 className="dash-date">{now.toFormat("cccc, LLLL d")}</h1>
            <p className="dash-time mono">
              {now.toFormat("h:mm a")} · {now.toFormat("yyyy")}
            </p>
          </div>
          {teams.length > 1 && (
            <label className="field inline team-switch">
              <span>Team</span>
              <select value={team?.id} onChange={(e) => setParams({ team: e.target.value })}>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>

        {!team ? (
          <div className="card empty-state">
            <h2>You're not on a team yet</h2>
            <p>Ask a team admin to add you to their People list. Once they do, your team's rooms will show up here.</p>
            {account.isAdmin && <Link className="btn primary" to="/admin">Go to the admin area</Link>}
          </div>
        ) : (
          <div className="tiles">
            <section className="tile tile-book">
              <p className="eyebrow">{team.name}</p>
              <h2>Book a room</h2>
              <p>Pick a room and time, or let us find what's free.</p>
              <div className="row wrap">
                <button className="btn on-accent" onClick={() => navigate(`${teamPath}?new=1`)}>New booking</button>
                <button className="btn ghost on-accent-ghost" onClick={() => navigate(`${teamPath}?view=find`)}>Find a free room</button>
                <button className="btn ghost on-accent-ghost" onClick={() => navigate(teamPath)}>See all rooms</button>
              </div>
            </section>

            <a className="tile tile-map" href={CAMPUS_MAP_URL} target="_blank" rel="noopener noreferrer">
              <div className="map-art" aria-hidden>
                <span className="pin" />
              </div>
              <div>
                <h2>Campus map</h2>
                <p>Find buildings and rooms on the Ontario Tech map.</p>
                <span className="tile-link">Open map ↗</span>
              </div>
            </a>

            <MonthCalendar team={team} isAdmin={team.role === "admin"} zone={zone} />

            <section className="tile tile-mine">
              <div className="row between">
                <h2>My upcoming bookings</h2>
              </div>
              {!mine.length ? (
                <p className="muted">Nothing booked yet. Bookings you make while signed in show up here.</p>
              ) : (
                <ul className="mine-list">
                  {mine.slice(0, 6).map((b) => (
                    <li key={b.id}>
                      <div className="mine-when mono">
                        <b>{DateTime.fromISO(b.startsAt).setZone(zone).toFormat("LLL d")}</b>
                        <span>{b.allDay ? "All day" : fmtTime(b.startsAt, zone)}</span>
                      </div>
                      <div className="mine-what">
                        <strong>{b.title}</strong>
                        <span className="muted">
                          {b.roomName}
                          {teams.length > 1 ? ` · ${b.teamName}` : ""}
                          {b.recurring ? " · repeats" : ""}
                        </span>
                        {b.status === "pending" && <span className="badge amber">Pending</span>}
                      </div>
                      <Link className="btn small" to={`/m/${b.manageToken}`}>Manage</Link>
                    </li>
                  ))}
                </ul>
              )}
              {mine.length > 6 && <p className="hint">And {mine.length - 6} more.</p>}
            </section>

            {team.role === "admin" && (
              <Link className="tile tile-admin" to={`/admin/teams/${team.id}`}>
                <h2>Manage {team.name}</h2>
                <p>Rooms, people, approvals, settings and activity.</p>
                <span className="tile-link">Open admin →</span>
              </Link>
            )}
          </div>
        )}
      </main>

      {pwOpen && <ChangePassword onClose={() => setPwOpen(false)} />}
    </div>
  );
}

function MonthCalendar({ team, isAdmin, zone }: { team: MyTeam; isAdmin: boolean; zone: string }) {
  const today = DateTime.now().setZone(zone).startOf("day");
  const [month, setMonth] = useState(today.startOf("month"));
  const [selected, setSelected] = useState(today.toISODate()!);
  const [bookings, setBookings] = useState<CalendarBooking[]>([]);
  const endpoints = isAdmin ? adminEndpoints(team.id) : staffEndpoints(team.id);

  useEffect(() => {
    const start = DateTime.fromObject({ year: month.year, month: month.month, day: 1 }, { zone }).startOf("week");
    const end = start.plus({ weeks: 6 });
    api<{ bookings: CalendarBooking[] }>(`${endpoints.events}?start=${encodeURIComponent(start.toUTC().toISO()!)}&end=${encodeURIComponent(end.toUTC().toISO()!)}`)
      .then((r) => setBookings(r.bookings))
      .catch(() => setBookings([]));
  }, [team.id, month.toISODate()]); // eslint-disable-line react-hooks/exhaustive-deps

  const byDay = useMemo(() => {
    const m = new Map<string, CalendarBooking[]>();
    for (const b of bookings) {
      const d = DateTime.fromISO(b.startsAt).setZone(zone).toISODate()!;
      m.set(d, [...(m.get(d) ?? []), b]);
    }
    return m;
  }, [bookings, zone]);

  const gridStart = DateTime.fromObject({ year: month.year, month: month.month, day: 1 }, { zone }).startOf("week");
  const cells = Array.from({ length: 42 }, (_, i) => gridStart.plus({ days: i }));
  const dayItems = (byDay.get(selected) ?? []).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const sel = DateTime.fromISO(selected, { zone });

  return (
    <section className="tile tile-cal">
      <div className="cal-head">
        <h2>{month.toFormat("LLLL yyyy")}</h2>
        <div className="btn-group">
          <button className="btn small ghost" aria-label="Previous month" onClick={() => setMonth(month.minus({ months: 1 }))}>←</button>
          <button className="btn small ghost" onClick={() => { setMonth(today.startOf("month")); setSelected(today.toISODate()!); }}>Today</button>
          <button className="btn small ghost" aria-label="Next month" onClick={() => setMonth(month.plus({ months: 1 }))}>→</button>
        </div>
      </div>
      <div className="cal-grid" role="grid" aria-label={`${month.toFormat("LLLL yyyy")} — days with bookings are marked`}>
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <span key={d} className="cal-wd" aria-hidden>{d.slice(0, 2)}</span>
        ))}
        {cells.map((c) => {
          const iso = c.toISODate()!;
          const n = byDay.get(iso)?.length ?? 0;
          const cls = [
            "cal-day",
            c.month !== month.month ? "out" : "",
            iso === today.toISODate() ? "today" : "",
            iso === selected ? "sel" : "",
          ].join(" ");
          return (
            <button key={iso} className={cls} onClick={() => setSelected(iso)} aria-pressed={iso === selected} aria-label={`${c.toFormat("cccc, LLLL d")}${n ? `, ${n} booking${n > 1 ? "s" : ""}` : ""}`}>
              <span>{c.day}</span>
              {n > 0 && <i className="cal-dots" aria-hidden>{n > 3 ? "•••" : "•".repeat(n)}</i>}
            </button>
          );
        })}
      </div>
      <div className="cal-agenda">
        <h3>{sel.hasSame(today, "day") ? "Today" : sel.toFormat("cccc, LLL d")}</h3>
        {!dayItems.length ? (
          <p className="muted">No bookings in {team.name} rooms.</p>
        ) : (
          <ul>
            {dayItems.map((b) => (
              <li key={b.id}>
                <span className="mono">{b.allDay ? "All day" : `${fmtTime(b.startsAt, zone)}–${fmtTime(b.endsAt, zone)}`}</span>
                <span>
                  <strong>{b.title}</strong>
                  {b.status === "pending" ? " · pending" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link className="tile-link" to={`/teams/${team.id}?date=${selected}`}>Open day view →</Link>
      </div>
    </section>
  );
}

function ChangePassword({ onClose }: { onClose: () => void }) {
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "" });
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  return (
    <Modal title="Change password" onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api("/admin/password", { body: pw });
            setMsg("Password changed. You've been signed out on other devices.");
            setPw({ currentPassword: "", newPassword: "" });
          } catch (err) {
            setError(errorText(err));
          }
        }}
      >
        <label className="field"><span>Current password</span><input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required autoComplete="current-password" /></label>
        <label className="field"><span>New password (10+ characters)</span><input type="password" minLength={10} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required autoComplete="new-password" /></label>
        {error && <p className="error">{error}</p>}
        {msg && <p className="notice">{msg}</p>}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary">Change password</button>
        </div>
      </form>
    </Modal>
  );
}
