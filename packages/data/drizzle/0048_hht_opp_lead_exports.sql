CREATE TABLE IF NOT EXISTS hht_opp_lead_exports (
  id serial PRIMARY KEY,
  root_domain text NOT NULL,
  lead_type text NOT NULL DEFAULT 'guest_post',
  batch_id text NOT NULL,
  file_name text NOT NULL,
  opportunity_url text,
  source_query text,
  bucket text,
  keyword_id integer REFERENCES hht_opp_guest_keywords(id) ON DELETE SET NULL,
  score double precision,
  exported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (root_domain, lead_type)
);

CREATE INDEX IF NOT EXISTS hht_opp_lead_exports_batch_idx
  ON hht_opp_lead_exports (batch_id);

CREATE INDEX IF NOT EXISTS hht_opp_lead_exports_keyword_idx
  ON hht_opp_lead_exports (keyword_id);
