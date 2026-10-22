CREATE TABLE IF NOT EXISTS admin_activity_retention_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  retention_days integer NOT NULL DEFAULT 15 CHECK (retention_days IN (10, 15, 30, 60, 90, 180, 365)),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO admin_activity_retention_settings(id, retention_days)
VALUES (1, 15)
ON CONFLICT (id) DO NOTHING;

-- migrate:down
DROP TABLE IF EXISTS admin_activity_retention_settings;
