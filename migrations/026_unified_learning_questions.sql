ALTER TABLE questions ADD COLUMN IF NOT EXISTS learning_level_id uuid REFERENCES learning_items(id) ON DELETE CASCADE;
ALTER TABLE questions ALTER COLUMN age_group_id DROP NOT NULL;
ALTER TABLE questions ALTER COLUMN category_id DROP NOT NULL;
ALTER TABLE questions ALTER COLUMN level_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS questions_learning_level_status_idx ON questions(learning_level_id,status,created_at);
INSERT INTO questions(id,learning_level_id,question_text,explanation,status,created_at,updated_at)
SELECT id,level_id,question_text,explanation,status,created_at,updated_at FROM learning_questions
ON CONFLICT(id) DO NOTHING;
INSERT INTO question_options(id,question_id,option_order,option_text,is_correct)
SELECT id,question_id,option_order,option_text,is_correct FROM learning_question_options
ON CONFLICT(id) DO NOTHING;
-- migrate:down
DELETE FROM questions WHERE learning_level_id IS NOT NULL;
ALTER TABLE questions DROP COLUMN IF EXISTS learning_level_id;
ALTER TABLE questions ALTER COLUMN age_group_id SET NOT NULL;
ALTER TABLE questions ALTER COLUMN category_id SET NOT NULL;
ALTER TABLE questions ALTER COLUMN level_id SET NOT NULL;
