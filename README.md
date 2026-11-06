# Room Scheduler

A room booking site for Netlify. Admins create **teams**, give each team its **rooms**, and share one link per team. Staff open the link and book rooms without logging in. Every booking comes with a private link that lets the booker edit or cancel it later.

- **Frontend:** React + TypeScript (Vite), FullCalendar for the room calendar view
- **API:** one Netlify Function (`netlify/functions/api.ts`) serving `/api/*`
- **Database:** Netlify Database (managed Postgres). The schema is in `netlify/database/migrations/` and Netlify applies it on every deploy.

---

## Deploy to Netlify

You need a Netlify account on a **credit-based plan**, because Netlify Database is only available on those plans.

1. **Put the code in a Git repository.** For example, create a new GitHub repo and push this folder to it.
2. In Netlify, choose **Add new project → Import an existing project** and pick the repo. The build settings come from `netlify.toml`, so you don't need to change anything.
3. Before the first deploy (or right after it), open **Project configuration → Environment variables** and add:

   | Key | Value |
   |---|---|
   | `ADMIN_SETUP_KEY` | Any long secret phrase. It's used once, to create the first admin account. |

4. **Deploy.** Netlify sees the `@netlify/database` package, provisions the database and applies the migration before publishing. You don't need to configure a connection string.
5. Open `https://<your-site>/admin`, enter the setup key, and create your admin account. **This first account is the super admin**, the only account that can see every team, manage other admins and read the all-teams activity log. The setup screen disappears once an admin exists, and the database allows only one super admin.
6. Create a team, add rooms on the **Rooms** tab, and share the **booking link** shown at the top of the team page.

> **Deploy previews** get their own database branch, which starts as a copy of production data, and preview links are public. Be careful who you share preview URLs with.

### Using the Netlify CLI instead of Git
```bash
npm install
npm install -g netlify-cli      # version 26 or newer
netlify login
netlify init                    # create or link a site
netlify env:set ADMIN_SETUP_KEY "your long secret phrase"
netlify deploy --build          # preview deploy first
netlify deploy --build --prod
```

---

## How it works

| Who | Where | What they can do |
|---|---|---|
| Super admin (one account) | `/admin` | Everything below, for **every** team, plus: add/remove admins and choose which teams each one manages, delete teams, and see the all-teams activity log (including sign-ins and failed sign-ins). |
| Admin | `/admin` | Only the teams the super admin assigns them, plus any team they create themselves. Rooms, categories, closures, approvals, settings, every booking in those teams, and each team's activity log. |
| Staff (members) | `/t/<team-link>` | No login. See the team's rooms and calendars, book, and see their own bookings under **My bookings** on that device. |
| Booker | `/m/<private-link>` | Edit or cancel that booking or series. Anyone with the link can do this. |

**Rooms:** name, room number/code, building, campus, floor, capacity, description (type, features, equipment, accessibility notes, directions), calendar colour, weekly opening hours (several ranges per day), active/inactive, needs approval, allowed categories, and optional per-room overrides of the team's booking rules.

**Teams:** name, description, time zone, booking link (can be regenerated), optional PIN, categories with colours, closures (team-wide or a single room), required fields (email / attendance / description), branding (accent colour and logo), default booking rules, and default hours for new rooms. Teams are completely separate from one another.

**Bookings:**
- Fields: title, category, date, start/end or all-day, staff member name, email (optional unless required), expected attendance, description (optional unless required), and a public/private toggle. Private bookings show as "Busy" to staff but are always fully visible to admins.
- Repeats can be daily, weekly on chosen days, or monthly (same date or same weekday, e.g. "2nd Tuesday"), every N days, weeks or months, ending on a date or after a number of times. A series is capped at 366 occurrences or two years.
- Editing a series offers **only this one**, **this and following**, or **all upcoming**.
- If some dates in a series have problems (a conflict, a closure, outside open hours), the booker sees exactly which ones and can book the rest.

**Find a free room:** pick a date and time, optionally a number of seats and a repeat pattern. You get the rooms that are free (or free on some of the dates), with the reason any room isn't, and a button to book straight from the results.

**Calendar subscriptions:** every team has `.ics` feed links that work in Outlook, Google Calendar and Apple Calendar, one for all rooms and one per room. The staff feed shows private bookings as "Busy". A separate admin feed includes full details. Regenerating the team link also resets every feed link.

**Printable schedules / PDF:** "Print or save as PDF" opens a clean schedule for one day, Mon–Fri, or any range up to 31 days, for all rooms or one room, grouped by room or by day. Use the browser's print dialog and choose "Save as PDF" to get a file.

**Activity log:** every booking, edit, cancellation, approval, room/category/closure/settings change, admin change and sign-in is recorded with who did it, when, and from which IP address. Staff are recorded by the name they typed, since they don't log in. Each team has an **Activity** tab. The super admin also has an all-teams **Activity** page, with filters and search.

**Rules enforced on the server:** opening hours, closures, time steps, minimum and maximum length, how far ahead people can book, buffer between bookings, capacity (warn or block), allowed categories, and no bookings in the past. Admins can tick **Override** to bypass these rules. Nobody can bypass overlaps: a Postgres exclusion constraint makes double-booking a room impossible, even when two people click "Book" at the same moment.

**Approval rooms:** new bookings are created as **Pending**, which already holds the time slot. Admins approve or decline them on the **Approvals** tab.

**Security notes:**
- Admin passwords are hashed with scrypt.
- Sessions use signed, HttpOnly cookies.
- Sign-in, PIN entry and booking are rate-limited.
- The booking form has a hidden honeypot field to catch bots.
- The API only accepts JSON bodies, which blocks cross-site form attacks.
- Because members don't log in, anyone with a team link can book. Use the PIN or regenerate the link if it spreads too far.

---

## Local development

```bash
npm install
netlify dev                          # starts the site, the functions, and a local database
netlify database migrations apply    # first time, in another terminal
```

### Tests
The API test suite runs against any Postgres 14+ that has the `btree_gist` extension:
```bash
tests/reset-db.sh postgres://postgres@localhost:5432      # creates rooms_test and applies migrations
ROOMS_DB_URL=postgres://postgres@localhost:5432/rooms_test npm test
```
It covers recurrence expansion, sign-in, every booking rule, simultaneous double-booking attempts, closures, recurring create/edit/cancel, privacy masking, approvals, admin override, daylight saving time, PINs, free-room search, calendar feeds, the activity log, and super-admin vs. team-admin permissions (90 checks).

You can also run the API on its own and point Vite at it:
```bash
ROOMS_DB_URL=... ADMIN_SETUP_KEY=dev npx tsx tests/server.ts     # API on :8788
API_PROXY=http://localhost:8788 npm run dev:web                  # site on :5173
```

### Changing the database later
Never edit a migration that has already been deployed. Add a new file, such as `netlify/database/migrations/20270101120000_add_something.sql`, and Netlify applies it on the next deploy.

---

## Project layout
```
netlify.toml                       build, SPA fallback, headers
netlify/functions/api.ts           the API function (routes in server/routes.ts)
netlify/database/migrations/       SQL schema, applied by Netlify on deploy
server/                            API code: routes, booking engine, recurrence, auth, rate limiting
shared/                            types and helpers used by both server and browser
src/                               React app (pages/, components/, styles.css)
tests/                             API test suite, local server harness, DB reset script
```
