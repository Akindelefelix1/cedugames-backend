-- Keep older deployments compatible with the current institution membership API.
ALTER TABLE institution_memberships
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

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
END $$;

-- Remove legacy values only after the old status constraint is gone.
UPDATE institution_memberships SET status = 'active' WHERE status = 'approved';

ALTER TABLE institution_memberships
  ADD CONSTRAINT institution_memberships_status_check
  CHECK (status IN ('pending', 'active', 'rejected'));

-- migrate:down
ALTER TABLE institution_memberships DROP CONSTRAINT IF EXISTS institution_memberships_status_check;
