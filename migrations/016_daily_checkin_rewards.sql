CREATE TABLE IF NOT EXISTS daily_checkin_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  is_enabled boolean NOT NULL DEFAULT true,
  timezone varchar(80) NOT NULL DEFAULT 'Africa/Lagos',
  title varchar(120) NOT NULL DEFAULT 'Daily learning reward',
  subtitle varchar(300) NOT NULL DEFAULT 'Come back every day and grow your streak!',
  rewards jsonb NOT NULL DEFAULT '[{"day":1,"coins":10},{"day":2,"coins":15},{"day":3,"coins":20},{"day":4,"coins":25},{"day":5,"coins":30},{"day":6,"coins":40},{"day":7,"coins":60}]'::jsonb,
  repeat_cycle boolean NOT NULL DEFAULT true,
  reset_after_missed_days integer NOT NULL DEFAULT 1 CHECK (reset_after_missed_days BETWEEN 1 AND 365),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(rewards) = 'array' AND jsonb_array_length(rewards) BETWEEN 1 AND 365)
);
INSERT INTO daily_checkin_settings(id) VALUES(1) ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS daily_checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checkin_date date NOT NULL,
  streak integer NOT NULL CHECK (streak > 0),
  cycle_day integer NOT NULL CHECK (cycle_day > 0),
  reward_amount integer NOT NULL CHECK (reward_amount > 0),
  transaction_id uuid REFERENCES coin_transactions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, checkin_date)
);
CREATE INDEX IF NOT EXISTS daily_checkins_user_date_idx ON daily_checkins(user_id, checkin_date DESC);
CREATE INDEX IF NOT EXISTS daily_checkins_date_idx ON daily_checkins(checkin_date DESC);

-- migrate:down
DROP TABLE IF EXISTS daily_checkins;
DROP TABLE IF EXISTS daily_checkin_settings;
