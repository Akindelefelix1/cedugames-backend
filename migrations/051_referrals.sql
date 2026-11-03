ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code varchar(16);
UPDATE users SET referral_code=upper(substr(encode(gen_random_bytes(8),'hex'),1,16))
WHERE role='user' AND parent_user_id IS NULL AND referral_code IS NULL;
ALTER TABLE users ALTER COLUMN referral_code SET DEFAULT upper(substr(encode(gen_random_bytes(8),'hex'),1,16));
CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_unique ON users(referral_code) WHERE referral_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS referral_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id=1),
  is_enabled boolean NOT NULL DEFAULT true,
  reward_coins integer NOT NULL DEFAULT 100 CHECK (reward_coins BETWEEN 1 AND 1000000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO referral_settings(id,is_enabled,reward_coins) VALUES(1,true,100) ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  referral_code varchar(16) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','qualified')),
  reward_coins integer,
  coin_transaction_id uuid REFERENCES coin_transactions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  qualified_at timestamptz,
  CHECK(referrer_id <> referred_user_id)
);
CREATE INDEX IF NOT EXISTS referrals_referrer_created_idx ON referrals(referrer_id,created_at DESC);

-- migrate:down
DROP TABLE IF EXISTS referrals;
DROP TABLE IF EXISTS referral_settings;
DROP INDEX IF EXISTS users_referral_code_unique;
ALTER TABLE users DROP COLUMN IF EXISTS referral_code;
