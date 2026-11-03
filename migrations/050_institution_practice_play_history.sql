CREATE TABLE IF NOT EXISTS institution_practice_plays (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level_id uuid REFERENCES institution_levels(id) ON DELETE SET NULL,
  subject text NOT NULL,
  question_ids uuid[] NOT NULL,
  expected_question_count integer NOT NULL CHECK (expected_question_count > 0),
  started_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz,
  correct_count integer,
  score_percent integer,
  passed boolean,
  life_lost boolean NOT NULL DEFAULT false,
  lives_after integer,
  coin_balance_after bigint,
  refilled boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS institution_practice_plays_history_idx
  ON institution_practice_plays(institution_id, user_id, completed_at DESC)
  WHERE completed_at IS NOT NULL;

ALTER TABLE institution_question_attempts
  ADD COLUMN IF NOT EXISTS play_id uuid REFERENCES institution_practice_plays(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS play_completed_at timestamptz;

CREATE INDEX IF NOT EXISTS institution_question_attempts_play_history_idx
  ON institution_question_attempts(institution_id, user_id, play_id, completed_at DESC)
  WHERE completed_at IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS institution_question_attempts_play_history_idx;
ALTER TABLE institution_question_attempts
  DROP COLUMN IF EXISTS play_completed_at,
  DROP COLUMN IF EXISTS play_id;
DROP INDEX IF EXISTS institution_practice_plays_history_idx;
DROP TABLE IF EXISTS institution_practice_plays;
