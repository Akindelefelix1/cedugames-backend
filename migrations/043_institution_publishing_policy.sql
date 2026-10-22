ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS publishing_policy varchar(24) NOT NULL DEFAULT 'admin_review';

ALTER TABLE institutions
  DROP CONSTRAINT IF EXISTS institutions_publishing_policy_check;
ALTER TABLE institutions
  ADD CONSTRAINT institutions_publishing_policy_check
  CHECK (publishing_policy IN ('admin_review', 'auto_publish'));

-- migrate:down
ALTER TABLE institutions DROP CONSTRAINT IF EXISTS institutions_publishing_policy_check;
ALTER TABLE institutions DROP COLUMN IF EXISTS publishing_policy;
