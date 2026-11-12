ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS popup_max_participants integer;

ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_popup_max_participants_check;
ALTER TABLE questions ADD CONSTRAINT questions_popup_max_participants_check
  CHECK (popup_max_participants IS NULL OR popup_max_participants BETWEEN 1 AND 10000000);

-- migrate:down
ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_popup_max_participants_check;
ALTER TABLE questions DROP COLUMN IF EXISTS popup_max_participants;
