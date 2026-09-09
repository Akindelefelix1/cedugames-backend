ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_url text;

-- migrate:down
ALTER TABLE users DROP COLUMN IF EXISTS profile_image_url;
