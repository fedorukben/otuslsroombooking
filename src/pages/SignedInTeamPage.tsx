import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { AdminTeam, Category, MyBooking, PublicTeam, Room } from "../../shared/types";
import { adminEndpoints, api, ApiError, errorText, staffEndpoints } from "../api";
import { Scheduler, type View } from "../components/Scheduler";
import { brandStyle, TeamHeader } from "./TeamPage";

/** /teams/:id — booking page for signed-in staff (and admins), reached from the dashboard. */
export function SignedInTeamPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [data, setData] = useState<{
    team: PublicTeam & { feedToken?: string; adminFeedToken?: string };
    rooms: Room[];
    categories: Category[];
    people: string[];
    me?: { name: string; email: string };
    admin: boolean;
    feedToken?: string;
  } | null>(null);
  const [own, setOwn] = useState<Map<number, string>>(new Map());
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const me = await api<{ teams: { id: number; role: string }[] }>("/me");
        const role = me.teams.find((t) => t.id === Number(id))?.role;
        if (!role) throw new Error("You're not on this team. Ask a team admin to add you to their People list.");
        if (role === "admin") {
          const r = await api<{ team: AdminTeam; rooms: Room[]; categories: Category[]; people: string[] }>(`/admin/teams/${id}`);
          setData({ ...r, admin: true, feedToken: r.team.feedToken });
        } else {
          const r = await api(`/s/teams/${id}`);
          setData({ ...r, admin: false });
          const mine = await api<{ bookings: MyBooking[] }>("/me/bookings");
          setOwn(new Map(mine.bookings.map((b) => [b.seriesId, b.manageToken])));
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) navigate("/");
        else setError(errorText(e));
      }
    })();
  }, [id, navigate]);

  if (error) {
    return (
      <main className="center-page">
        <div className="card narrow">
          <h1>Can't open this team</h1>
          <p>{error}</p>
          <Link to="/" className="btn">Back to dashboard</Link>
        </div>
      </main>
    );
  }
  if (!data) return <main className="center-page"><p className="muted">Loading…</p></main>;

  const view = (params.get("view") as View | null) ?? "day";
  const endpoints = data.admin ? adminEndpoints(Number(id)) : staffEndpoints(Number(id));
  return (
    <div className="member-shell" style={brandStyle(data.team.accentColor)}>
      <TeamHeader name={data.team.name} description={data.team.description} logo={data.team.logoDataUrl}>
        <Link className="btn ghost" to={`/?team=${id}`}>← Dashboard</Link>
      </TeamHeader>
      <main className="page">
        <Scheduler
          team={data.team}
          rooms={data.rooms}
          categories={data.categories}
          endpoints={endpoints}
          feedToken={data.feedToken}
          adminFeedToken={data.admin ? data.team.adminFeedToken : undefined}
          printPath={data.admin ? `/admin/teams/${id}/print` : `/print/s/${id}`}
          people={data.people}
          self={data.admin ? undefined : data.me}
          ownSeries={data.admin ? undefined : own}
          initialView={["day", "room", "find", "rooms"].includes(view) ? view : "day"}
          openNew={params.get("new") === "1"}
          initialDate={params.get("date") ?? undefined}
        />
      </main>
    </div>
  );
}
