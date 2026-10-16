CREATE TABLE IF NOT EXISTS institutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  owner_name varchar(120) NOT NULL,
  email varchar(320) NOT NULL,
  password text NOT NULL,
  phone varchar(30),
  is_active boolean NOT NULL DEFAULT true,
  token_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS institutions_email_lower_unique ON institutions (lower(email));

-- migrate:down
DROP INDEX IF EXISTS institutions_email_lower_unique;
DROP TABLE IF EXISTS institutions;
