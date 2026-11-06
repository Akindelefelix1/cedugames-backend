CREATE TABLE IF NOT EXISTS institution_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  email varchar(320) NOT NULL,
  name varchar(160),
  role varchar(32) NOT NULL DEFAULT 'teacher' CHECK (role IN ('teacher','content_manager','viewer')),
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked')),
  password text,
  invitation_token_hash text UNIQUE,
  invitation_expires_at timestamptz,
  token_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (institution_id, email)
);

CREATE INDEX IF NOT EXISTS institution_staff_institution_idx ON institution_staff(institution_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS institution_staff_email_lower_idx ON institution_staff(lower(email));

-- migrate:down
DROP TABLE IF EXISTS institution_staff;
