-- Room Scheduler: initial schema.
-- Applied automatically by Netlify on deploy. Never edit after it has been applied;
-- add a new, later-numbered migration instead.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Single-row table holding the secret used to sign admin session cookies.
-- Generated on first use by the API so no environment variable is needed.
CREATE TABLE IF NOT EXISTS app_secrets (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  session_secret TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- Weekly hours JSON shape: {"1": [[480, 1020]], ..., "7": []}
--   keys are ISO weekdays (1 = Monday ... 7 = Sunday),
--   values are lists of [startMinute, endMinute] ranges measured from local midnight.
CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'America/Toronto',
  share_token TEXT NOT NULL UNIQUE,
  pin_hash TEXT,
  accent_color TEXT NOT NULL DEFAULT '#0b5cad',
  logo_data_url TEXT,
  slot_minutes INTEGER NOT NULL DEFAULT 30,
  min_minutes INTEGER NOT NULL DEFAULT 30,
  max_minutes INTEGER NOT NULL DEFAULT 240,
  max_days_ahead INTEGER NOT NULL DEFAULT 120,
  buffer_minutes INTEGER NOT NULL DEFAULT 0,
  capacity_mode TEXT NOT NULL DEFAULT 'warn' CHECK (capacity_mode IN ('warn', 'block')),
  require_email BOOLEAN NOT NULL DEFAULT FALSE,
  require_attendance BOOLEAN NOT NULL DEFAULT FALSE,
  require_description BOOLEAN NOT NULL DEFAULT FALSE,
  default_hours JSONB NOT NULL DEFAULT '{"1":[[510,1020]],"2":[[510,1020]],"3":[[510,1020]],"4":[[510,1020]],"5":[[510,1020]],"6":[],"7":[]}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#0b5cad',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (team_id, name)
);

CREATE TABLE IF NOT EXISTS rooms (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  building TEXT NOT NULL DEFAULT '',
  campus TEXT NOT NULL DEFAULT '',
  floor TEXT NOT NULL DEFAULT '',
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#0b5cad',
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  allowed_category_ids INTEGER[] NOT NULL DEFAULT '{}',
  hours JSONB NOT NULL,
  -- Per-room overrides of the team's booking rules. NULL = use the team default.
  slot_minutes INTEGER,
  min_minutes INTEGER,
  max_minutes INTEGER,
  max_days_ahead INTEGER,
  buffer_minutes INTEGER,
  capacity_mode TEXT CHECK (capacity_mode IS NULL OR capacity_mode IN ('warn', 'block')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rooms_team_idx ON rooms (team_id);

-- Closures: room_id NULL means the whole team is closed on those dates.
CREATE TABLE IF NOT EXISTS closures (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS closures_team_idx ON closures (team_id, start_date, end_date);

-- Every booking belongs to a series. One-off bookings are a series of one.
-- The manage_token is the private link that lets the booker edit or cancel without logging in.
CREATE TABLE IF NOT EXISTS booking_series (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  manage_token TEXT NOT NULL UNIQUE,
  recurrence JSONB,
  created_by_admin BOOLEAN NOT NULL DEFAULT FALSE,
  creator_ip TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  series_id INTEGER NOT NULL REFERENCES booking_series(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  staff_name TEXT NOT NULL,
  staff_email TEXT NOT NULL DEFAULT '',
  attendance INTEGER CHECK (attendance IS NULL OR attendance > 0),
  description TEXT NOT NULL DEFAULT '',
  is_private BOOLEAN NOT NULL DEFAULT FALSE,
  all_day BOOLEAN NOT NULL DEFAULT FALSE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'pending', 'cancelled')),
  is_exception BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  CONSTRAINT bookings_time_order CHECK (ends_at > starts_at),
  -- The database itself refuses overlapping active bookings in the same room,
  -- so two people clicking "Book" at the same moment can never both succeed.
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    room_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status <> 'cancelled')
);
CREATE INDEX IF NOT EXISTS bookings_team_time_idx ON bookings (team_id, starts_at);
CREATE INDEX IF NOT EXISTS bookings_series_idx ON bookings (series_id);
CREATE INDEX IF NOT EXISTS bookings_pending_idx ON bookings (team_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
