ALTER TABLE institution_questions
  DROP CONSTRAINT IF EXISTS institution_questions_review_status_check;
ALTER TABLE institution_questions
  ADD CONSTRAINT institution_questions_review_status_check
  CHECK (review_status IN ('draft', 'pending', 'approved', 'changes_requested'));

-- migrate:down
UPDATE institution_questions SET review_status='pending' WHERE review_status='draft';
ALTER TABLE institution_questions DROP CONSTRAINT IF EXISTS institution_questions_review_status_check;
ALTER TABLE institution_questions
  ADD CONSTRAINT institution_questions_review_status_check
  CHECK (review_status IN ('pending', 'approved', 'changes_requested'));
