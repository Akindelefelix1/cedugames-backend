ALTER TABLE institution_questions
  ADD COLUMN IF NOT EXISTS review_status varchar(24) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS review_notes text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE institution_questions
  DROP CONSTRAINT IF EXISTS institution_questions_review_status_check;
ALTER TABLE institution_questions
  ADD CONSTRAINT institution_questions_review_status_check
  CHECK (review_status IN ('pending', 'approved', 'changes_requested'));

UPDATE institution_questions SET review_status='approved'
WHERE status='published' AND review_status='pending';

CREATE INDEX IF NOT EXISTS institution_questions_review_queue_idx
  ON institution_questions(created_at DESC)
  WHERE status='draft' AND review_status='pending';

-- migrate:down
DROP INDEX IF EXISTS institution_questions_review_queue_idx;
ALTER TABLE institution_questions DROP CONSTRAINT IF EXISTS institution_questions_review_status_check;
ALTER TABLE institution_questions
  DROP COLUMN IF EXISTS reviewed_by,
  DROP COLUMN IF EXISTS reviewed_at,
  DROP COLUMN IF EXISTS review_notes,
  DROP COLUMN IF EXISTS review_status;
