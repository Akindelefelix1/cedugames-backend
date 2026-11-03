ALTER TABLE institution_question_attempts
  ADD COLUMN IF NOT EXISTS selected_option_order smallint,
  ADD COLUMN IF NOT EXISTS is_correct boolean,
  ADD COLUMN IF NOT EXISTS timed_out boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS institution_question_attempts_history_idx
  ON institution_question_attempts(institution_id, user_id, completed_at DESC)
  WHERE completed_at IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS institution_question_attempts_history_idx;
ALTER TABLE institution_question_attempts
  DROP COLUMN IF EXISTS timed_out,
  DROP COLUMN IF EXISTS is_correct,
  DROP COLUMN IF EXISTS selected_option_order;
