ALTER TABLE users ADD COLUMN IF NOT EXISTS phone varchar(20);

CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique
  ON users (phone)
  WHERE phone IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS users_phone_unique;
ALTER TABLE users DROP COLUMN IF EXISTS phone;