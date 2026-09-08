CREATE TABLE IF NOT EXISTS airtime_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  points_per_naira integer NOT NULL DEFAULT 10 CHECK (points_per_naira > 0),
  minimum_amount_minor integer NOT NULL DEFAULT 10000 CHECK (minimum_amount_minor > 0),
  maximum_amount_minor integer NOT NULL DEFAULT 500000 CHECK (maximum_amount_minor >= minimum_amount_minor),
  is_enabled boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO airtime_settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS airtime_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coin_transaction_id uuid NOT NULL UNIQUE REFERENCES coin_transactions(id) ON DELETE RESTRICT,
  phone varchar(20) NOT NULL,
  network varchar(20) NOT NULL,
  points_used integer NOT NULL CHECK (points_used > 0),
  points_per_naira integer NOT NULL CHECK (points_per_naira > 0),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'NGN',
  reference varchar(160) NOT NULL UNIQUE,
  provider_reference varchar(160),
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','successful','failed','refunded')),
  failure_reason varchar(500),
  provider_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS airtime_redemptions_user_created_idx ON airtime_redemptions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS airtime_redemptions_admin_created_idx ON airtime_redemptions(created_at DESC);
CREATE INDEX IF NOT EXISTS airtime_redemptions_status_idx ON airtime_redemptions(status);

-- migrate:down
DROP TABLE IF EXISTS airtime_redemptions;
DROP TABLE IF EXISTS airtime_settings;
