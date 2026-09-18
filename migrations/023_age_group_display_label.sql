ALTER TABLE age_groups
  ADD COLUMN IF NOT EXISTS display_label varchar(120) NOT NULL DEFAULT '';

-- migrate:down
ALTER TABLE age_groups DROP COLUMN IF EXISTS display_label;