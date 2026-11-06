import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import "./styles.css";
import { AccountsPage } from "./pages/admin/AccountsPage";
import { AdminShell } from "./pages/admin/AdminShell";
import { TeamAdminPage } from "./pages/admin/TeamAdminPage";
import { TeamsPage } from "./pages/admin/TeamsPage";
import { ManagePage } from "./pages/ManagePage";
import { PrintPage } from "./pages/PrintPage";
import { ActivityPage } from "./pages/admin/ActivityPage";
import { TeamPage } from "./pages/TeamPage";

function Home() {
  return (
    <main className="center-page home">
      <div className="home-card">
        <p className="eyebrow">Room Scheduler</p>
        <h1>
          Book the room.
          <br />
          <span>Skip the email chain.</span>
        </h1>
        <p className="lede">Staff book through their team's link — ask your team admin for it. Your booking confirmation includes a private link for changes.</p>
        <Link className="btn primary" to="/admin">
          Admin sign-in
        </Link>
      </div>
    </main>
  );
}

function NotFound() {
  return (
    <main className="center-page">
      <div className="card narrow">
        <h1>Page not found</h1>
        <p>
          <Link to="/">Go to the start page</Link>
        </p>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/t/:token" element={<TeamPage />} />
        <Route path="/m/:token" element={<ManagePage />} />
        <Route path="/print/t/:token" element={<PrintPage />} />
        <Route path="/admin/teams/:id/print" element={<AdminShell bare><PrintPage admin /></AdminShell>} />
        <Route path="/admin/activity" element={<AdminShell><ActivityPage /></AdminShell>} />
        <Route path="/admin" element={<AdminShell><TeamsPage /></AdminShell>} />
        <Route path="/admin/teams/:id" element={<AdminShell><TeamAdminPage /></AdminShell>} />
        <Route path="/admin/accounts" element={<AdminShell><AccountsPage /></AdminShell>} />
        <Route path="/admin/manage/:token" element={<AdminShell><ManagePage admin /></AdminShell>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
