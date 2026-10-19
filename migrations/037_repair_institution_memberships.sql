-- Keep older deployments compatible with the current institution membership API.
ALTER TABLE institution_memberships
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Older deployments used "approved" while the current API uses "active".
UPDATE institution_memberships SET status = 'active' WHERE status = 'approved';

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'institution_memberships'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE institution_memberships DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  ALTER TABLE institution_memberships
    ADD CONSTRAINT institution_memberships_status_check
    CHECK (status IN ('pending', 'active', 'rejected'));
END $$;

-- migrate:down
ALTER TABLE institution_memberships DROP CONSTRAINT IF EXISTS institution_memberships_status_check;
