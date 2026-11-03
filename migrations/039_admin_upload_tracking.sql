CREATE TABLE IF NOT EXISTS admin_upload_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_name varchar(120) NOT NULL,
  upload_type varchar(60) NOT NULL,
  question_count integer NOT NULL DEFAULT 0 CHECK (question_count >= 0),
  image_count integer NOT NULL DEFAULT 0 CHECK (image_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_upload_events_created_at_idx ON admin_upload_events(created_at DESC);
CREATE INDEX IF NOT EXISTS admin_upload_events_actor_id_idx ON admin_upload_events(actor_id);
CREATE INDEX IF NOT EXISTS admin_upload_events_upload_type_idx ON admin_upload_events(upload_type);

-- migrate:down
DROP TABLE IF EXISTS admin_upload_events;
