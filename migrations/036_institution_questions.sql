CREATE TABLE IF NOT EXISTS institution_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  level_id uuid NOT NULL REFERENCES institution_levels(id) ON DELETE CASCADE,
  subject varchar(120) NOT NULL,
  question_text text NOT NULL,
  explanation text NOT NULL DEFAULT '',
  status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS institution_question_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES institution_questions(id) ON DELETE CASCADE,
  option_order smallint NOT NULL CHECK (option_order BETWEEN 0 AND 3),
  option_text text NOT NULL,
  is_correct boolean NOT NULL DEFAULT false,
  UNIQUE (question_id, option_order)
);
CREATE INDEX IF NOT EXISTS institution_questions_level_idx ON institution_questions(level_id, subject, status, created_at DESC);

-- migrate:down
DROP TABLE IF EXISTS institution_question_options;
DROP TABLE IF EXISTS institution_questions;
