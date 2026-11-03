ALTER TABLE institutions
  ADD COLUMN IF NOT EXISTS admin_status varchar(20) NOT NULL DEFAULT 'Active'
    CHECK (admin_status IN ('Active', 'Needs review', 'Suspended'));

-- migrate:down
ALTER TABLE institutions DROP COLUMN IF EXISTS admin_status;
