CREATE TABLE IF NOT EXISTS family_page_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  advert_image_url TEXT,
  advert_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  slider_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO family_page_settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS family_page_slides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_url TEXT NOT NULL,
  position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(position)
);

-- migrate:down
DROP TABLE IF EXISTS family_page_slides;
DROP TABLE IF EXISTS family_page_settings;
