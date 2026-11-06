-- Super admin, per-team admins, calendar feed tokens, and the activity log.

-- Exactly one super admin: the first account created (the person who deployed the site).
ALTER TABLE admins ADD COLUMN IF NOT EXISTS is_super BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE admins SET is_super = TRUE
 WHERE id = (SELECT MIN(id) FROM admins)
   AND NOT EXISTS (SELECT 1 FROM admins WHERE is_super);
CREATE UNIQUE INDEX IF NOT EXISTS admins_single_super ON admins (is_super) WHERE is_super;

-- Which teams each (non-super) admin can manage.
CREATE TABLE IF NOT EXISTS team_admins (
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (admin_id, team_id)
);
-- Keep existing admins' access: before this migration every admin could manage every team.
INSERT INTO team_admins (admin_id, team_id)
SELECT a.id, t.id FROM admins a CROSS JOIN teams t WHERE NOT a.is_super
ON CONFLICT DO NOTHING;

-- Calendar subscription (.ics) feed tokens. feed_token shows what staff see (private = "Busy");
-- admin_feed_token includes full details and is only shown to admins.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS feed_token TEXT;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS admin_feed_token TEXT;
UPDATE teams SET feed_token = replace(gen_random_uuid()::text, '-', '') WHERE feed_token IS NULL;
UPDATE teams SET admin_feed_token = replace(gen_random_uuid()::text, '-', '') WHERE admin_feed_token IS NULL;
ALTER TABLE teams ALTER COLUMN feed_token SET NOT NULL;
ALTER TABLE teams ALTER COLUMN admin_feed_token SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS teams_feed_token_idx ON teams (feed_token);
CREATE UNIQUE INDEX IF NOT EXISTS teams_admin_feed_token_idx ON teams (admin_feed_token);

-- Activity log: who did what, when. team_name is a snapshot so entries survive team deletion.
CREATE TABLE IF NOT EXISTS activity_log (
  id BIGSERIAL PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  team_name TEXT NOT NULL DEFAULT '',
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'member', 'system')),
  admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS activity_team_idx ON activity_log (team_id, id DESC);
CREATE INDEX IF NOT EXISTS activity_created_idx ON activity_log (id DESC);
