ALTER TABLE hht_engine.keywords
  ADD COLUMN IF NOT EXISTS serp_overlap double precision,
  ADD COLUMN IF NOT EXISTS neighborhood text;

CREATE TABLE IF NOT EXISTS hht_engine.frontier_log (
  id serial PRIMARY KEY,
  event_type text NOT NULL,
  keyword_id integer,
  url text,
  root_domain text,
  stage text,
  quality text,
  lane text,
  affiliate boolean,
  score double precision,
  reasons jsonb,
  pitchable_domains integer,
  overlap double precision,
  neighborhood text,
  candidates_added integer,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hht_engine_frontier_log_event_idx
  ON hht_engine.frontier_log (event_type, created_at);
