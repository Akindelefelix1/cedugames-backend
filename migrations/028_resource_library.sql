CREATE TABLE IF NOT EXISTS resource_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS resource_categories_name_unique
  ON resource_categories (LOWER(name));

CREATE TABLE IF NOT EXISTS resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID REFERENCES resource_categories(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  url TEXT NOT NULL UNIQUE,
  public_id TEXT,
  resource_type VARCHAR(30) NOT NULL DEFAULT 'image',
  mime_type VARCHAR(120),
  source VARCHAR(30) NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'question')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS resources_category_created_idx
  ON resources(category_id, created_at DESC);

INSERT INTO resources(name, url, resource_type, mime_type, source)
SELECT 'Question image', media_url, 'image', 'image/*', 'question'
FROM questions
WHERE media_url IS NOT NULL AND media_type = 'image'
ON CONFLICT (url) DO NOTHING;

INSERT INTO resources(name, url, resource_type, mime_type, source)
SELECT 'Answer option image', media_url, 'image', 'image/*', 'question'
FROM question_options
WHERE media_url IS NOT NULL AND media_type = 'image'
ON CONFLICT (url) DO NOTHING;

-- migrate:down
DROP TABLE IF EXISTS resources;
DROP TABLE IF EXISTS resource_categories;
