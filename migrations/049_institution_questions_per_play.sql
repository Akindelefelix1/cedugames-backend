ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS questions_per_play integer NOT NULL DEFAULT 10;

ALTER TABLE institutions
  DROP CONSTRAINT IF EXISTS institutions_questions_per_play_check;

ALTER TABLE institutions
  ADD CONSTRAINT institutions_questions_per_play_check
  CHECK (questions_per_play BETWEEN 1 AND 200);

-- migrate:down
ALTER TABLE institutions DROP CONSTRAINT IF EXISTS institutions_questions_per_play_check;
ALTER TABLE institutions DROP COLUMN IF EXISTS questions_per_play;