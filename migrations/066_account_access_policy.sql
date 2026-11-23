CREATE TABLE IF NOT EXISTS account_access_policy (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id=1),
  require_player_email_verification boolean NOT NULL DEFAULT false,
  require_child_deletion_otp boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO account_access_policy(id,require_player_email_verification,require_child_deletion_otp)
VALUES (1,false,true) ON CONFLICT(id) DO NOTHING;

-- migrate:down
DROP TABLE IF EXISTS account_access_policy;
