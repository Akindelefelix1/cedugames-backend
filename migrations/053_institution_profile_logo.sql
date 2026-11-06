ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS logo_url text;

-- migrate:down
ALTER TABLE institutions DROP COLUMN IF EXISTS logo_url;
