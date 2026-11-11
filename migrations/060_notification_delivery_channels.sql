ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS channels text[] NOT NULL DEFAULT ARRAY['in_app','push']::text[],
  ADD COLUMN IF NOT EXISTS email_status varchar(20) NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_error text,
  ADD COLUMN IF NOT EXISTS email_success_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_failure_count integer NOT NULL DEFAULT 0;

-- Keep historical campaigns visible in-app and preserve their existing push history.
UPDATE notifications SET channels=ARRAY['in_app','push']::text[] WHERE channels IS NULL OR cardinality(channels)=0;
UPDATE notifications SET email_status='not_requested' WHERE email_status IS NULL;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_push_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_push_status_check
  CHECK (push_status IN ('pending','processing','sent','failed','not_configured','not_requested'));
ALTER TABLE notifications ADD CONSTRAINT notifications_email_status_check
  CHECK (email_status IN ('pending','processing','sent','failed','not_configured','not_requested'));
ALTER TABLE notifications ADD CONSTRAINT notifications_channels_check
  CHECK (cardinality(channels)>0 AND channels <@ ARRAY['in_app','email','push']::text[]);

-- migrate:down
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_channels_check;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_email_status_check;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_push_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_push_status_check
  CHECK (push_status IN ('pending','processing','sent','failed','not_configured'));
ALTER TABLE notifications DROP COLUMN IF EXISTS email_failure_count;
ALTER TABLE notifications DROP COLUMN IF EXISTS email_success_count;
ALTER TABLE notifications DROP COLUMN IF EXISTS email_error;
ALTER TABLE notifications DROP COLUMN IF EXISTS email_started_at;
ALTER TABLE notifications DROP COLUMN IF EXISTS email_sent_at;
ALTER TABLE notifications DROP COLUMN IF EXISTS email_status;
ALTER TABLE notifications DROP COLUMN IF EXISTS channels;
