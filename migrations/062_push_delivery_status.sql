ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_push_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_push_status_check
  CHECK (push_status IN ('pending','processing','sent','partial','failed','not_configured','not_requested','no_devices'));

-- migrate:down
UPDATE notifications SET push_status='sent' WHERE push_status='partial';
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_push_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_push_status_check
  CHECK (push_status IN ('pending','processing','sent','failed','not_configured','not_requested','no_devices'));
