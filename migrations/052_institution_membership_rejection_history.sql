ALTER TABLE institution_memberships
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_count integer NOT NULL DEFAULT 0;

-- Preserve an initial rejection when upgrading existing databases.
UPDATE institution_memberships
SET rejected_at = COALESCE(rejected_at, updated_at, requested_at),
    rejection_count = GREATEST(rejection_count, 1)
WHERE status = 'rejected';

-- migrate:down
ALTER TABLE institution_memberships
  DROP COLUMN IF EXISTS rejection_count,
  DROP COLUMN IF EXISTS rejected_at;
