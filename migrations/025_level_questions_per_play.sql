ALTER TABLE game_levels ADD COLUMN IF NOT EXISTS questions_per_play integer NOT NULL DEFAULT 10 CHECK (questions_per_play BETWEEN 1 AND 200);
-- migrate:down
ALTER TABLE game_levels DROP COLUMN IF EXISTS questions_per_play;
