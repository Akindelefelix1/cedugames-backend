ALTER TABLE institutions ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;
ALTER TABLE institutions ADD COLUMN IF NOT EXISTS invite_code varchar(20);

UPDATE institutions
SET invite_code = 'CEDU-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
WHERE invite_code IS NULL;

ALTER TABLE institutions ALTER COLUMN invite_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS institutions_invite_code_unique ON institutions (upper(invite_code));

CREATE TABLE IF NOT EXISTS institution_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected')),
  source varchar(20) NOT NULL DEFAULT 'public' CHECK (source IN ('public', 'invite_code')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, user_id)
);

CREATE INDEX IF NOT EXISTS institution_memberships_user_idx ON institution_memberships(user_id, status);
CREATE INDEX IF NOT EXISTS institution_memberships_institution_idx ON institution_memberships(institution_id, status);

-- migrate:down
DROP TABLE IF EXISTS institution_memberships;
DROP INDEX IF EXISTS institutions_invite_code_unique;
ALTER TABLE institutions DROP COLUMN IF EXISTS invite_code;
ALTER TABLE institutions DROP COLUMN IF EXISTS is_public;
