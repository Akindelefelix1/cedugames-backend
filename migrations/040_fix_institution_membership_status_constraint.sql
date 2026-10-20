-- Reapply the membership status repair for databases that already recorded migration 037.
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

UPDATE institution_memberships SET status = 'active' WHERE status = 'approved';

ALTER TABLE institution_memberships
  ADD CONSTRAINT institution_memberships_status_check
  CHECK (status IN ('pending', 'active', 'rejected'));

-- migrate:down
-- Keep the compatible constraint because the legacy constraint varied by deployment.
SELECT 1;
