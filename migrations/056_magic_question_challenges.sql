ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS is_magic boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS magic_reward_coins integer NOT NULL DEFAULT 0;

ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_magic_reward_check;
ALTER TABLE questions ADD CONSTRAINT questions_magic_reward_check
  CHECK ((is_magic AND magic_reward_coins BETWEEN 1 AND 1000000) OR (NOT is_magic AND magic_reward_coins = 0));

CREATE TABLE IF NOT EXISTS magic_question_claims (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  coin_transaction_id uuid NOT NULL REFERENCES coin_transactions(id),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, question_id),
  UNIQUE (coin_transaction_id)
);

CREATE TABLE IF NOT EXISTS magic_question_answers (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  option_id uuid NOT NULL,
  is_correct boolean NOT NULL,
  answered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, question_id)
);

-- migrate:down
DROP TABLE IF EXISTS magic_question_answers;
DROP TABLE IF EXISTS magic_question_claims;
ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_magic_reward_check;
ALTER TABLE questions DROP COLUMN IF EXISTS magic_reward_coins, DROP COLUMN IF EXISTS is_magic;
