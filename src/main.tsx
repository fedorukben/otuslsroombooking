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
import { InvitePage, RecoverPage, ResetPage, StaffInvitePage } from "./pages/admin/AuthPages";
import { Home } from "./pages/Dashboard";
import { SignedInTeamPage } from "./pages/SignedInTeamPage";
import { TeamPage } from "./pages/TeamPage";

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
        <Route path="/teams/:id" element={<SignedInTeamPage />} />
        <Route path="/print/s/:id" element={<PrintPage staff />} />
        <Route path="/invite/:token" element={<StaffInvitePage />} />
        <Route path="/reset/:token" element={<ResetPage />} />
        <Route path="/t/:token" element={<TeamPage />} />
        <Route path="/m/:token" element={<ManagePage />} />
        <Route path="/print/t/:token" element={<PrintPage />} />
        <Route path="/admin/teams/:id/print" element={<AdminShell bare><PrintPage admin /></AdminShell>} />
        <Route path="/admin/invite/:token" element={<InvitePage />} />
        <Route path="/admin/reset/:token" element={<ResetPage />} />
        <Route path="/admin/recover" element={<RecoverPage />} />
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
