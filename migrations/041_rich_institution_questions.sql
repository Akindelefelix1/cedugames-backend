ALTER TABLE institution_questions
  ADD COLUMN IF NOT EXISTS media_url text,
  ADD COLUMN IF NOT EXISTS media_type varchar(20),
  ADD COLUMN IF NOT EXISTS read_aloud boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shape_type varchar(20),
  ADD COLUMN IF NOT EXISTS shape_color varchar(7);

ALTER TABLE institution_question_options
  ADD COLUMN IF NOT EXISTS media_url text,
  ADD COLUMN IF NOT EXISTS media_type varchar(20),
  ADD COLUMN IF NOT EXISTS shape_type varchar(20),
  ADD COLUMN IF NOT EXISTS shape_color varchar(7);

-- migrate:down
ALTER TABLE institution_question_options
  DROP COLUMN IF EXISTS shape_color,
  DROP COLUMN IF EXISTS shape_type,
  DROP COLUMN IF EXISTS media_type,
  DROP COLUMN IF EXISTS media_url;
ALTER TABLE institution_questions
  DROP COLUMN IF EXISTS shape_color,
  DROP COLUMN IF EXISTS shape_type,
  DROP COLUMN IF EXISTS read_aloud,
  DROP COLUMN IF EXISTS media_type,
  DROP COLUMN IF EXISTS media_url;
