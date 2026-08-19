CREATE TABLE IF NOT EXISTS player_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  age_group_id uuid REFERENCES age_groups(id) ON DELETE SET NULL,
  category_id uuid REFERENCES game_categories(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Historical databases can contain retry rows from before action idempotency
-- was enforced. Keep that ledger intact and add a lookup index; the gameplay
-- transaction serializes and checks this key before recording new charges.
CREATE INDEX IF NOT EXISTS coin_transactions_game_action_once
  ON coin_transactions(user_id,(metadata->>'levelId'),(metadata->>'questionId'),(metadata->>'eventKey'))
  WHERE reference LIKE 'game-action:%';
-- migrate:down
DROP INDEX IF EXISTS coin_transactions_game_action_once;
DROP TABLE IF EXISTS player_preferences;
