import { one, q, type Queryable, db } from "./db.js";
import { bad } from "./http.js";
import type { TeamRow } from "./mappers.js";

export interface PersonRow {
  id: number;
  team_id: number;
  name: string;
  email: string;
  role: string;
  active: boolean;
  admin_id: number | null;
}

/** Adds someone to a team's people list unless a person with that name or email is already there. */
export async function ensurePerson(teamId: number, name: string, email: string, adminId: number | null = null, client: Queryable = db()) {
  await client.query(
    `INSERT INTO people (team_id, name, email, admin_id)
     SELECT $1, $2, $3, $4
      WHERE NOT EXISTS (
        SELECT 1 FROM people WHERE team_id = $1 AND (lower(name) = lower($2) OR ($3 <> '' AND lower(email) = lower($3)))
      )
     ON CONFLICT DO NOTHING`,
    [teamId, name, email, adminId],
  );
}

export async function activePeopleNames(teamId: number): Promise<string[]> {
  const rows = await q<{ name: string }>("SELECT name FROM people WHERE team_id = $1 AND active ORDER BY lower(name)", [teamId]);
  return rows.map((r) => r.name);
}

/**
 * Before a booking is saved: when the team only allows listed people, check the name (members only);
 * and when no email was typed, use the email on file for that person.
 */
export async function applyPeopleList(team: TeamRow, raw: any, admin: boolean): Promise<any> {
  const name = typeof raw?.staffName === "string" ? raw.staffName.trim() : "";
  if (!name) return raw;
  const person = await one<PersonRow>("SELECT * FROM people WHERE team_id = $1 AND lower(name) = lower($2)", [team.id, name]);
  if (!admin && team.people_only && (!person || !person.active)) {
    const any = await one("SELECT 1 FROM people WHERE team_id = $1 AND active LIMIT 1", [team.id]);
    if (any) throw bad("Choose your name from the list. If you're not on it, ask a team admin to add you.");
  }
  if (person && !String(raw.staffEmail ?? "").trim() && person.email) {
    return { ...raw, staffName: person.name, staffEmail: person.email };
  }
  return person ? { ...raw, staffName: person.name } : raw;
}
