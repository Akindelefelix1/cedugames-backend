CREATE TABLE IF NOT EXISTS institution_question_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES institution_questions(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_key uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, question_id, attempt_key)
);

CREATE INDEX IF NOT EXISTS institution_question_attempts_user_question_idx
  ON institution_question_attempts(user_id, question_id, started_at DESC);

-- migrate:down
DROP TABLE IF EXISTS institution_question_attempts;
