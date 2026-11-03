ALTER TABLE institutions ADD COLUMN IF NOT EXISTS institution_type varchar(80);
ALTER TABLE institutions ADD COLUMN IF NOT EXISTS address varchar(240);
ALTER TABLE institutions ADD COLUMN IF NOT EXISTS city varchar(100);
ALTER TABLE institutions ADD COLUMN IF NOT EXISTS state varchar(100);
ALTER TABLE institutions ADD COLUMN IF NOT EXISTS country varchar(100) NOT NULL DEFAULT 'Nigeria';

-- migrate:down
ALTER TABLE institutions DROP COLUMN IF EXISTS country;
ALTER TABLE institutions DROP COLUMN IF EXISTS state;
ALTER TABLE institutions DROP COLUMN IF EXISTS city;
ALTER TABLE institutions DROP COLUMN IF EXISTS address;
ALTER TABLE institutions DROP COLUMN IF EXISTS institution_type;
