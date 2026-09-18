ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS read_aloud boolean NOT NULL DEFAULT false;

-- migrate:down
ALTER TABLE questions DROP COLUMN IF EXISTS read_aloud;