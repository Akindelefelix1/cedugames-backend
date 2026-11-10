ALTER TABLE otps DROP CONSTRAINT IF EXISTS otps_purpose_check;
ALTER TABLE otps ADD CONSTRAINT otps_purpose_check
  CHECK (purpose IN ('register', 'password_reset', 'institution_password_reset'));

-- migrate:down
DELETE FROM otps WHERE purpose='institution_password_reset';
ALTER TABLE otps DROP CONSTRAINT IF EXISTS otps_purpose_check;
ALTER TABLE otps ADD CONSTRAINT otps_purpose_check
  CHECK (purpose IN ('register', 'password_reset'));
