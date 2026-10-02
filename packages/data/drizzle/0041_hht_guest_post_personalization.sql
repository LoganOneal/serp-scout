ALTER TABLE hht_engine.domains
  ADD COLUMN IF NOT EXISTS submission_method text,
  ADD COLUMN IF NOT EXISTS submission_url text,
  ADD COLUMN IF NOT EXISTS pitch_topic_count integer,
  ADD COLUMN IF NOT EXISTS pitch_content_stage text,
  ADD COLUMN IF NOT EXISTS required_subject_line_format text,
  ADD COLUMN IF NOT EXISTS accepted_topics jsonb,
  ADD COLUMN IF NOT EXISTS excluded_topics jsonb,
  ADD COLUMN IF NOT EXISTS word_count text,
  ADD COLUMN IF NOT EXISTS link_policy text,
  ADD COLUMN IF NOT EXISTS samples_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bio_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_content_policy text,
  ADD COLUMN IF NOT EXISTS ai_content_prohibited boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS paid_or_sponsored boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS guideline_evidence jsonb;

ALTER TABLE hht_engine.opportunities
  ADD COLUMN IF NOT EXISTS guest_post_pitch_topics jsonb,
  ADD COLUMN IF NOT EXISTS guest_post_fit_line text,
  ADD COLUMN IF NOT EXISTS guest_post_fit_line_citations jsonb,
  ADD COLUMN IF NOT EXISTS guest_post_subject_line text,
  ADD COLUMN IF NOT EXISTS guest_post_subject_line_citations jsonb;

ALTER TABLE hht_engine.domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE hht_engine.opportunities ENABLE ROW LEVEL SECURITY;
