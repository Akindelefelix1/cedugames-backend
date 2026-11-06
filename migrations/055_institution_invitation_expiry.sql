ALTER TABLE institution_invitations
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE institution_invitations
SET expires_at = created_at + INTERVAL '7 days'
WHERE expires_at IS NULL;

UPDATE institution_invitations
SET status = 'canceled'
WHERE status = 'sent' AND expires_at <= NOW();

WITH duplicates AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY institution_id, LOWER(target) ORDER BY created_at DESC, id DESC) AS position
  FROM institution_invitations
  WHERE status = 'sent'
)
UPDATE institution_invitations invitations
SET status = 'canceled'
FROM duplicates
WHERE invitations.id = duplicates.id AND duplicates.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS institution_invitations_one_pending_target_idx
  ON institution_invitations(institution_id, LOWER(target))
  WHERE status = 'sent';

-- migrate:down
DROP INDEX IF EXISTS institution_invitations_one_pending_target_idx;
ALTER TABLE institution_invitations DROP COLUMN IF EXISTS expires_at;
