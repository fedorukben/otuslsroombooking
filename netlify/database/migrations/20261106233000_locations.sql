-- Per-team lists of campuses and buildings, chosen from dropdowns when adding rooms.
-- Rooms keep storing the campus and building names as text (so nothing about existing rooms changes);
-- these lists are where the dropdown options come from, and renaming here updates matching rooms.

CREATE TABLE IF NOT EXISTS campuses (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS campuses_team_name_idx ON campuses (team_id, lower(name));

CREATE TABLE IF NOT EXISTS buildings (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  campus_id INTEGER REFERENCES campuses(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS buildings_team_name_idx ON buildings (team_id, lower(name));

-- Start the lists from what existing rooms already use.
INSERT INTO campuses (team_id, name)
SELECT DISTINCT ON (team_id, lower(campus)) team_id, campus
  FROM rooms WHERE campus <> ''
ON CONFLICT DO NOTHING;

INSERT INTO buildings (team_id, name, campus_id)
SELECT DISTINCT ON (r.team_id, lower(r.building)) r.team_id, r.building, c.id
  FROM rooms r
  LEFT JOIN campuses c ON c.team_id = r.team_id AND lower(c.name) = lower(r.campus)
 WHERE r.building <> ''
 ORDER BY r.team_id, lower(r.building), c.id NULLS LAST
ON CONFLICT DO NOTHING;
