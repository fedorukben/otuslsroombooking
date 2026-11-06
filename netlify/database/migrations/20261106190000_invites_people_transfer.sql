-- Invite links, password reset links, super admin handover, and per-team people lists.

-- Bumped whenever a password changes or is reset, which signs the admin out everywhere else.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;

-- Single-use links. Only a SHA-256 hash of the token is stored, so a database leak can't be used to sign in.
--   invite:   creates a new admin (name, email, team_ids) who sets their own password
--   reset:    lets admin_id set a new password
--   transfer: offers the super admin role to admin_id; created_by keeps team_ids if accepted
CREATE TABLE IF NOT EXISTS admin_tokens (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('invite', 'reset', 'transfer')),
  token_hash TEXT NOT NULL UNIQUE,
  admin_id INTEGER REFERENCES admins(id) ON DELETE CASCADE,
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  team_ids INTEGER[] NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES admins(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_tokens_open_idx ON admin_tokens (kind) WHERE used_at IS NULL;
-- At most one open handover offer at a time.
CREATE UNIQUE INDEX IF NOT EXISTS admin_tokens_one_transfer ON admin_tokens (kind) WHERE kind = 'transfer' AND used_at IS NULL;

-- Staff who book rooms, per team. Shown as a dropdown on the booking form.
CREATE TABLE IF NOT EXISTS people (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS people_team_name_idx ON people (team_id, lower(name));

-- When on, staff must pick their name from the list (admins can still type any name).
ALTER TABLE teams ADD COLUMN IF NOT EXISTS people_only BOOLEAN NOT NULL DEFAULT FALSE;

-- Start each team's list with the admins who manage it.
INSERT INTO people (team_id, name, email, admin_id)
SELECT ta.team_id, a.name, a.email, a.id
  FROM team_admins ta JOIN admins a ON a.id = ta.admin_id
ON CONFLICT DO NOTHING;
