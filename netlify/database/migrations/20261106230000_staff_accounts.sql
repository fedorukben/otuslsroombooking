-- Staff sign-in. The admins table becomes the table of all accounts:
-- is_admin = TRUE for admins (every existing row), FALSE for staff accounts.

ALTER TABLE admins ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_super_is_admin;
ALTER TABLE admins ADD CONSTRAINT admins_super_is_admin CHECK (NOT is_super OR is_admin);

-- Staff invite links point at the People-list entry they're for.
ALTER TABLE admin_tokens DROP CONSTRAINT IF EXISTS admin_tokens_kind_check;
ALTER TABLE admin_tokens ADD CONSTRAINT admin_tokens_kind_check CHECK (kind IN ('invite', 'reset', 'transfer', 'staff_invite'));
ALTER TABLE admin_tokens ADD COLUMN IF NOT EXISTS person_id INTEGER REFERENCES people(id) ON DELETE CASCADE;

-- people.admin_id now means "the account this person signs in with". One entry per account per team.
CREATE UNIQUE INDEX IF NOT EXISTS people_team_account_idx ON people (team_id, admin_id) WHERE admin_id IS NOT NULL;

-- Which account made a booking (NULL for bookings made through a team link).
ALTER TABLE booking_series ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES admins(id) ON DELETE SET NULL;

-- Whether the no-login team link still works. Existing teams keep it until an admin turns it off.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS link_access BOOLEAN NOT NULL DEFAULT TRUE;
