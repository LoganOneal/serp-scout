CREATE TABLE IF NOT EXISTS hht_opp_guest_keywords (
  id serial PRIMARY KEY,
  keyword text NOT NULL,
  normalized_keyword text NOT NULL,
  source_type text NOT NULL DEFAULT 'seed',
  status text NOT NULL DEFAULT 'NEW',
  skip_reason text,
  neighborhood text,
  serp_overlap double precision,
  new_domains integer NOT NULL DEFAULT 0,
  units_spent integer,
  fetched_at timestamptz,
  ideas_expanded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (normalized_keyword)
);

CREATE INDEX IF NOT EXISTS hht_opp_guest_keywords_status_idx
  ON hht_opp_guest_keywords (status, created_at);

CREATE TABLE IF NOT EXISTS hht_opp_guest_serp_results (
  id serial PRIMARY KEY,
  keyword_id integer NOT NULL REFERENCES hht_opp_guest_keywords(id) ON DELETE CASCADE,
  position integer NOT NULL,
  url text NOT NULL,
  domain text NOT NULL,
  UNIQUE (keyword_id, url)
);

CREATE TABLE IF NOT EXISTS hht_opp_guest_evaluations (
  id serial PRIMARY KEY,
  root_domain text NOT NULL,
  verdict text NOT NULL,
  pitch_url text,
  quote text,
  contact_method text,
  contact_value text,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (root_domain)
);
