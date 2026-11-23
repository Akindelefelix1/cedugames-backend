-- Revoke existing player sessions and require email verification for every
-- password-based account that was previously created while verification was off.
UPDATE users
SET is_verified = false,
    token_version = token_version + 1,
    updated_at = NOW()
WHERE role = 'user'
  AND parent_user_id IS NULL
  AND is_oauth = false
  AND is_verified = true;

-- migrate:down
-- Verification status is intentionally not restored on rollback. Re-enabling
-- unverified accounts would bypass the requirement this migration establishes.
