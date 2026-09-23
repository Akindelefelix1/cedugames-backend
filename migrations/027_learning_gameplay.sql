ALTER TABLE learning_items
  ADD COLUMN IF NOT EXISTS points_per_question integer NOT NULL DEFAULT 10 CHECK (points_per_question BETWEEN 1 AND 1000),
  ADD COLUMN IF NOT EXISTS time_limit_seconds integer NOT NULL DEFAULT 30 CHECK (time_limit_seconds BETWEEN 5 AND 600),
  ADD COLUMN IF NOT EXISTS questions_per_play integer NOT NULL DEFAULT 10 CHECK (questions_per_play BETWEEN 1 AND 200);

ALTER TABLE gameplay_attempts
  ADD COLUMN IF NOT EXISTS learning_level_id uuid REFERENCES learning_items(id) ON DELETE CASCADE;

ALTER TABLE gameplay_attempts ALTER COLUMN level_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS gameplay_attempts_learning_level_idx
  ON gameplay_attempts(user_id, learning_level_id, created_at DESC);

-- migrate:down
DROP INDEX IF EXISTS gameplay_attempts_learning_level_idx;
ALTER TABLE gameplay_attempts DROP COLUMN IF EXISTS learning_level_id;
ALTER TABLE learning_items
  DROP COLUMN IF EXISTS questions_per_play,
  DROP COLUMN IF EXISTS time_limit_seconds,
  DROP COLUMN IF EXISTS points_per_question;
