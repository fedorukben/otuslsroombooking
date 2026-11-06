import { ActivityList } from "../../components/ActivityList";
import { useAdmin } from "./AdminShell";

/** Every team's activity plus sign-ins and admin changes. Super admin only. */
export function ActivityPage() {
  const { me } = useAdmin();
  if (!me.isSuper) {
    return (
      <main className="page narrow-page">
        <p className="error">Only the super admin can see activity across all teams. Open a team to see its activity.</p>
      </main>
    );
  }
  return (
    <main className="page">
      <p className="eyebrow">Super admin</p>
      <h1>Activity across all teams</h1>
      <p className="muted">Bookings, changes, settings, admin accounts and sign-ins (including failed attempts), newest first.</p>
      <ActivityList showTeam />
    </main>
  );
}
