ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS activity_retention_days integer NOT NULL DEFAULT 15;

ALTER TABLE institutions
  DROP CONSTRAINT IF EXISTS institutions_activity_retention_days_check;
ALTER TABLE institutions
  ADD CONSTRAINT institutions_activity_retention_days_check
  CHECK (activity_retention_days IN (15, 30));

-- migrate:down
ALTER TABLE institutions DROP CONSTRAINT IF EXISTS institutions_activity_retention_days_check;
ALTER TABLE institutions DROP COLUMN IF EXISTS activity_retention_days;