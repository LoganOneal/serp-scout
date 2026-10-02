CREATE TABLE IF NOT EXISTS hht_engine.lead_reviews (
  id serial PRIMARY KEY,
  opportunity_id integer NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  subject text,
  body text,
  sequence jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewer text,
  notes text,
  approved_hash text,
  approved_at timestamptz,
  rejected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lead_reviews_opportunity_idx
  ON hht_engine.lead_reviews (opportunity_id);
CREATE INDEX IF NOT EXISTS lead_reviews_status_idx
  ON hht_engine.lead_reviews (status);

CREATE TABLE IF NOT EXISTS hht_engine.lead_review_events (
  id serial PRIMARY KEY,
  opportunity_id integer NOT NULL,
  review_id integer NOT NULL,
  decision text NOT NULL,
  reviewer text,
  notes text,
  content_hash text,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_review_events_opportunity_idx
  ON hht_engine.lead_review_events (opportunity_id, created_at);

ALTER TABLE hht_engine.crm_outbox
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'PENDING_APPROVAL',
  ADD COLUMN IF NOT EXISTS approved_review_id integer,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS queued_at timestamptz;

UPDATE hht_engine.crm_outbox
   SET status = 'PENDING_APPROVAL'
 WHERE approved_review_id IS NULL
   AND synced_at IS NULL;

ALTER TABLE hht_engine.lead_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE hht_engine.lead_review_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hht_engine.crm_outbox ENABLE ROW LEVEL SECURITY;
