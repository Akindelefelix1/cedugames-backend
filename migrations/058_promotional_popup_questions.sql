ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS is_popup boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS popup_reward_coins integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS popup_audience varchar(20) NOT NULL DEFAULT 'all_users',
  ADD COLUMN IF NOT EXISTS popup_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS popup_campaign_id uuid,
  ADD COLUMN IF NOT EXISTS popup_activated_at timestamptz;

ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_popup_campaign_check;
ALTER TABLE questions ADD CONSTRAINT questions_popup_campaign_check CHECK (
  popup_audience IN ('new_users', 'all_users')
  AND popup_reward_coins BETWEEN 0 AND 1000000
  AND (
    (NOT is_popup AND popup_reward_coins = 0 AND NOT popup_active AND popup_campaign_id IS NULL AND popup_activated_at IS NULL)
    OR
    (is_popup AND popup_reward_coins BETWEEN 1 AND 1000000
      AND ((popup_active AND status = 'published' AND popup_campaign_id IS NOT NULL AND popup_activated_at IS NOT NULL)
        OR (NOT popup_active AND popup_campaign_id IS NULL AND popup_activated_at IS NULL)))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS questions_popup_campaign_unique
  ON questions(popup_campaign_id) WHERE popup_campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS questions_active_popup_idx
  ON questions(popup_activated_at DESC, created_at DESC)
  WHERE is_popup = true AND popup_active = true AND status = 'published';

CREATE TABLE IF NOT EXISTS popup_question_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  selected_option_id uuid NOT NULL,
  is_correct boolean NOT NULL,
  reward_coins integer NOT NULL DEFAULT 0 CHECK (reward_coins >= 0),
  answered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS popup_question_answers_user_idx
  ON popup_question_answers(user_id, answered_at DESC);

-- migrate:down
DROP TABLE IF EXISTS popup_question_answers;
DROP INDEX IF EXISTS questions_active_popup_idx;
DROP INDEX IF EXISTS questions_popup_campaign_unique;
ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_popup_campaign_check;
ALTER TABLE questions DROP COLUMN IF EXISTS popup_activated_at,
  DROP COLUMN IF EXISTS popup_campaign_id,
  DROP COLUMN IF EXISTS popup_active,
  DROP COLUMN IF EXISTS popup_audience,
  DROP COLUMN IF EXISTS popup_reward_coins,
  DROP COLUMN IF EXISTS is_popup;
