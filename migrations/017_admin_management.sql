ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_title varchar(80) NOT NULL DEFAULT 'Administrator';
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_permissions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS users_admin_active_idx ON users(role,is_active) WHERE role='admin';

-- migrate:down
DROP INDEX IF EXISTS users_admin_active_idx;
ALTER TABLE users DROP COLUMN IF EXISTS is_active;
ALTER TABLE users DROP COLUMN IF EXISTS admin_permissions;
ALTER TABLE users DROP COLUMN IF EXISTS admin_title;
