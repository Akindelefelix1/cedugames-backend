ALTER TABLE otps DROP CONSTRAINT IF EXISTS otps_purpose_check;
ALTER TABLE otps ADD CONSTRAINT otps_purpose_check
  CHECK (purpose IN ('register', 'password_reset', 'institution_password_reset', 'child_delete'));

-- migrate:down
DELETE FROM otps WHERE purpose='child_delete';
ALTER TABLE otps DROP CONSTRAINT IF EXISTS otps_purpose_check;
ALTER TABLE otps ADD CONSTRAINT otps_purpose_check
  CHECK (purpose IN ('register', 'password_reset', 'institution_password_reset'));
