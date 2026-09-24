CREATE TABLE IF NOT EXISTS learning_programs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title varchar(120) NOT NULL UNIQUE, slug varchar(120) NOT NULL UNIQUE,
 tag varchar(120) NOT NULL DEFAULT '', description text NOT NULL DEFAULT '', image_url text NOT NULL,
 program_type varchar(20) NOT NULL CHECK(program_type IN ('games','learn')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS learning_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), program_id uuid NOT NULL REFERENCES learning_programs(id) ON DELETE CASCADE,
 parent_id uuid REFERENCES learning_items(id) ON DELETE CASCADE, item_type varchar(20) NOT NULL CHECK(item_type IN ('section','grade','subject','topic','level')),
 title varchar(120) NOT NULL, tag varchar(120) NOT NULL DEFAULT '', description text NOT NULL DEFAULT '', image_url text NOT NULL,
 sort_order integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(program_id,parent_id,title)
);
CREATE TABLE IF NOT EXISTS learning_questions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),level_id uuid NOT NULL REFERENCES learning_items(id) ON DELETE CASCADE,question_text text NOT NULL,explanation text NOT NULL DEFAULT '',status varchar(20) NOT NULL DEFAULT 'published' CHECK(status IN ('draft','published')),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS learning_question_options (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),question_id uuid NOT NULL REFERENCES learning_questions(id) ON DELETE CASCADE,option_order smallint NOT NULL CHECK(option_order BETWEEN 0 AND 3),option_text text NOT NULL,is_correct boolean NOT NULL DEFAULT false,UNIQUE(question_id,option_order));
INSERT INTO learning_programs(title,slug,tag,description,image_url,program_type) VALUES
('CEDUGAMES','cedugames','Games','Fun, age-based learning games.','https://res.cloudinary.com/demo/image/upload/v1312461204/sample.jpg','games'),
('CEDU-LEARN','cedu-learn','Learning','Structured learning by class, subject and topic.','https://res.cloudinary.com/demo/image/upload/v1312461204/sample.jpg','learn') ON CONFLICT(slug) DO NOTHING;
INSERT INTO learning_items(program_id,item_type,title,tag,description,image_url,sort_order) SELECT id,'section','Junior Classes','Junior','Learning paths for junior classes.',image_url,1 FROM learning_programs WHERE slug='cedu-learn' ON CONFLICT DO NOTHING;
INSERT INTO learning_items(program_id,item_type,title,tag,description,image_url,sort_order) SELECT id,'section','Senior Classes','Senior','Learning paths for senior classes.',image_url,2 FROM learning_programs WHERE slug='cedu-learn' ON CONFLICT DO NOTHING;
-- migrate:down
DROP TABLE IF EXISTS learning_question_options; DROP TABLE IF EXISTS learning_questions; DROP TABLE IF EXISTS learning_items; DROP TABLE IF EXISTS learning_programs;
