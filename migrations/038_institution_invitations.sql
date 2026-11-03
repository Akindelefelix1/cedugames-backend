CREATE TABLE IF NOT EXISTS institution_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  target varchar(320) NOT NULL,
  channel varchar(10) NOT NULL CHECK (channel IN ('email','phone')),
  status varchar(20) NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','used','canceled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

CREATE INDEX IF NOT EXISTS institution_invitations_institution_idx ON institution_invitations(institution_id, created_at DESC);

-- migrate:down
DROP TABLE IF EXISTS institution_invitations;
