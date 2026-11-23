-- Child profiles are funded independently by their account creator. They do
-- not receive the 100-coin welcome balance intended for household accounts.
-- Only reset legacy child profiles that still have the untouched database
-- default and no coin ledger entries; preserve every balance with activity.
UPDATE users child
SET coins_count = 0,
    updated_at = NOW()
WHERE child.parent_user_id IS NOT NULL
  AND child.coins_count = 100
  AND NOT EXISTS (
    SELECT 1 FROM coin_transactions t WHERE t.user_id = child.id
  );

-- Make the safe balance the database default. Only household account creation
-- explicitly grants the welcome coins.
ALTER TABLE users ALTER COLUMN coins_count SET DEFAULT 0;

-- migrate:down
-- Restore the legacy default for an application rollback. Existing child
-- balances are not restored; they may have changed since this migration.
ALTER TABLE users ALTER COLUMN coins_count SET DEFAULT 100;
