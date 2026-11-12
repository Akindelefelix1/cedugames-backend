ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_push_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_push_status_check
  CHECK (push_status IN ('pending','processing','sent','failed','not_configured','not_requested','no_devices'));

-- Previous sends with no successes or failures had no matching registered devices.
UPDATE notifications
SET push_status='no_devices',push_error=COALESCE(push_error,'No registered devices matched this audience.')
WHERE push_status='sent' AND 'push'=ANY(channels)
  AND COALESCE(push_success_count,0)=0 AND COALESCE(push_failure_count,0)=0;

-- migrate:down
UPDATE notifications SET push_status='sent' WHERE push_status='no_devices';
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_push_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_push_status_check
  CHECK (push_status IN ('pending','processing','sent','failed','not_configured','not_requested'));
