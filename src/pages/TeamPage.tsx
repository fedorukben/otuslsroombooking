import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import type { Category, PublicTeam, Room } from "../../shared/types";
import { api, ApiError, errorText, memberEndpoints, pinStore } from "../api";
import { Scheduler } from "../components/Scheduler";
import { savedBookings } from "../lib/storage";
import { onColor } from "../lib/time";

interface Data {
  team: PublicTeam;
  rooms: Room[];
  categories: Category[];
  feedToken: string;
}

export function brandStyle(accent: string): CSSProperties {
  return { ["--accent" as string]: accent, ["--on-accent" as string]: onColor(accent) };
}

export function TeamHeader({ name, description, logo, children }: { name: string; description?: string; logo?: string | null; children?: React.ReactNode }) {
  return (
    <header className="team-header">
      <div className="team-id">
        {logo && <img src={logo} alt="" className="team-logo" />}
        <div>
          <p className="eyebrow">Room booking</p>
          <h1>{name}</h1>
          {description && <p className="team-desc">{description}</p>}
        </div>
      </div>
      {children}
    </header>
  );
}

export function TeamPage() {
  const { token = "" } = useParams();
  const [data, setData] = useState<Data | null>(null);
  const [gate, setGate] = useState<{ teamName: string; accentColor: string; logoDataUrl: string | null; error: string } | null>(null);
  const [error, setError] = useState("");
  const [pin, setPin] = useState("");
  const [showMine, setShowMine] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api<Data>(`/t/${token}`, { headers: memberEndpoints(token).headers });
      setData(d);
      setGate(null);
      document.title = `${d.team.name} · Room booking`;
    } catch (err) {
      if (err instanceof ApiError && err.data?.pinRequired) {
        setGate({ teamName: err.data.teamName, accentColor: err.data.accentColor, logoDataUrl: err.data.logoDataUrl, error: pinStore.get(token) ? err.message : "" });
      } else setError(errorText(err));
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function submitPin(e: FormEvent) {
    e.preventDefault();
    pinStore.set(token, pin);
    await load();
  }

  if (error) {
    return (
      <main className="center-page">
        <div className="card narrow">
          <h1>Link not available</h1>
          <p>{error}</p>
        </div>
      </main>
    );
  }

  if (gate) {
    return (
      <main className="center-page" style={brandStyle(gate.accentColor)}>
        <form className="card narrow" onSubmit={submitPin}>
          {gate.logoDataUrl && <img src={gate.logoDataUrl} alt="" className="team-logo" />}
          <p className="eyebrow">Room booking</p>
          <h1>{gate.teamName}</h1>
          <label className="field">
            <span>Team PIN</span>
            <input inputMode="numeric" autoComplete="off" pattern="\d*" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus required />
          </label>
          {gate.error && (
            <p className="error" role="alert">
              {gate.error}
            </p>
          )}
          <button className="btn primary block">Continue</button>
        </form>
      </main>
    );
  }

  if (!data) return <main className="center-page"><p className="muted">Loading…</p></main>;

  const mine = savedBookings.list().filter((b) => b.teamName === data.team.name);

  return (
    <div className="member-shell" style={brandStyle(data.team.accentColor)}>
      <TeamHeader name={data.team.name} description={data.team.description} logo={data.team.logoDataUrl}>
        <button className="btn ghost" onClick={() => setShowMine((v) => !v)} aria-expanded={showMine}>
          My bookings{mine.length ? ` (${mine.length})` : ""}
        </button>
      </TeamHeader>
      {showMine && (
        <section className="mine card">
          <h2>My bookings on this device</h2>
          {!mine.length ? (
            <p className="muted">Bookings you make here are remembered on this device so you can edit or cancel them.</p>
          ) : (
            <ul>
              {mine.map((b) => (
                <li key={b.token}>
                  <Link to={`/m/${b.token}`}>{b.title}</Link>
                  <span className="muted">
                    {" "}
                    · {b.roomName} · {b.firstStart}
                    {b.recurring ? " · repeats" : ""}
                  </span>
                  <button className="link-btn" onClick={() => { savedBookings.remove(b.token); setShowMine(false); setTimeout(() => setShowMine(true)); }}>
                    Forget
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <main className="page">
        <Scheduler
          team={data.team}
          rooms={data.rooms}
          categories={data.categories}
          endpoints={memberEndpoints(token)}
          feedToken={data.feedToken}
          printPath={`/print/t/${token}`}
        />
      </main>
    </div>
  );
}
