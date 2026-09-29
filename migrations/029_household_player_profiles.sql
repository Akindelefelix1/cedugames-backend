ALTER TABLE users
  ADD COLUMN IF NOT EXISTS parent_user_id uuid REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS users_parent_user_id_idx ON users(parent_user_id);

-- Only top-level household accounts can authenticate. Child rows deliberately
-- have no password and keep all existing player-owned foreign keys usable.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_child_account_shape;
ALTER TABLE users ADD CONSTRAINT users_child_account_shape CHECK (
  parent_user_id IS NULL OR (parent_user_id <> id AND role = 'user' AND password IS NULL)
);

-- migrate:down
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_child_account_shape;
DROP INDEX IF EXISTS users_parent_user_id_idx;
ALTER TABLE users DROP COLUMN IF EXISTS parent_user_id;
