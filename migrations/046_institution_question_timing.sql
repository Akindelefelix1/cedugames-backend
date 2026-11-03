ALTER TABLE institution_questions
  ADD COLUMN IF NOT EXISTS time_limit_seconds integer NOT NULL DEFAULT 30;

ALTER TABLE institution_questions
  DROP CONSTRAINT IF EXISTS institution_questions_time_limit_seconds_check;
ALTER TABLE institution_questions
  ADD CONSTRAINT institution_questions_time_limit_seconds_check
  CHECK (time_limit_seconds BETWEEN 5 AND 600);

-- migrate:down
ALTER TABLE institution_questions DROP CONSTRAINT IF EXISTS institution_questions_time_limit_seconds_check;
ALTER TABLE institution_questions DROP COLUMN IF EXISTS time_limit_seconds;