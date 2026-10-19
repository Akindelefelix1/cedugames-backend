CREATE TABLE IF NOT EXISTS institution_structure_settings (
  institution_id uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
  category_label varchar(80) NOT NULL DEFAULT 'Section',
  level_label varchar(80) NOT NULL DEFAULT 'Class',
  learner_label varchar(80) NOT NULL DEFAULT 'Learners',
  subject_label varchar(80) NOT NULL DEFAULT 'Learning areas',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS institution_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  description varchar(500) NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, name)
);

CREATE TABLE IF NOT EXISTS institution_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES institution_categories(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  code varchar(80) NOT NULL DEFAULT '',
  learner_count integer NOT NULL DEFAULT 0 CHECK (learner_count >= 0),
  subjects jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, name)
);

CREATE INDEX IF NOT EXISTS institution_categories_institution_idx ON institution_categories(institution_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS institution_levels_institution_idx ON institution_levels(institution_id, category_id, sort_order, created_at);

-- migrate:down
DROP TABLE IF EXISTS institution_levels;
DROP TABLE IF EXISTS institution_categories;
DROP TABLE IF EXISTS institution_structure_settings;
