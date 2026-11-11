ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS target_user_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS push_status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (push_status IN ('pending','processing','sent','failed','not_configured')),
  ADD COLUMN IF NOT EXISTS push_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS push_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS push_error text,
  ADD COLUMN IF NOT EXISTS push_success_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS push_failure_count integer NOT NULL DEFAULT 0;
-- Existing in-app notifications have already been published; migration must not
-- cause the new worker to replay them as fresh push campaigns.
UPDATE notifications SET push_status='sent' WHERE push_status='pending';
CREATE INDEX IF NOT EXISTS notifications_schedule_idx ON notifications(scheduled_at) WHERE push_status='pending';

CREATE TABLE IF NOT EXISTS push_device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  platform varchar(16) NOT NULL CHECK(platform IN ('android','ios')),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_device_tokens_user_idx ON push_device_tokens(user_id);

-- migrate:down
DROP TABLE IF EXISTS push_device_tokens;
DROP INDEX IF EXISTS notifications_schedule_idx;
ALTER TABLE notifications DROP COLUMN IF EXISTS push_failure_count;
ALTER TABLE notifications DROP COLUMN IF EXISTS push_success_count;
ALTER TABLE notifications DROP COLUMN IF EXISTS push_error;
ALTER TABLE notifications DROP COLUMN IF EXISTS push_sent_at;
ALTER TABLE notifications DROP COLUMN IF EXISTS push_started_at;
ALTER TABLE notifications DROP COLUMN IF EXISTS push_status;
ALTER TABLE notifications DROP COLUMN IF EXISTS target_user_ids;
ALTER TABLE notifications DROP COLUMN IF EXISTS scheduled_at;
