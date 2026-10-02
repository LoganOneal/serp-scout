CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS supabase_vault;
CREATE SCHEMA IF NOT EXISTS hht_engine;

CREATE TABLE IF NOT EXISTS hht_engine.keywords (
  id serial PRIMARY KEY,
  keyword text NOT NULL,
  normalized_keyword text NOT NULL,
  source_type text NOT NULL,
  source_keyword_id integer,
  source_domain text,
  source_url text,
  semantic_cluster text,
  geo_city text,
  geo_state text,
  intent_type text,
  avg_monthly_searches integer,
  volume_low integer,
  volume_high integer,
  volume_is_range boolean NOT NULL DEFAULT false,
  volume_source text,
  keyword_difficulty double precision,
  relevance_score double precision,
  relevance_method text,
  priority_score double precision NOT NULL DEFAULT 0,
  expansion_depth integer NOT NULL DEFAULT 0,
  max_serp_position_scanned integer NOT NULL DEFAULT 0,
  unique_domains_seen integer NOT NULL DEFAULT 0,
  new_domains_discovered integer NOT NULL DEFAULT 0,
  guest_post_domains integer NOT NULL DEFAULT 0,
  insertion_candidates integer NOT NULL DEFAULT 0,
  marginal_domain_yield double precision,
  marginal_opportunity_yield double precision,
  consecutive_low_yield_bands integer NOT NULL DEFAULT 0,
  last_serp_scan_at timestamptz,
  status text NOT NULL DEFAULT 'NEW',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS keywords_normalized_idx ON hht_engine.keywords (normalized_keyword);
CREATE INDEX IF NOT EXISTS keywords_status_priority_idx ON hht_engine.keywords (status, priority_score);

CREATE TABLE IF NOT EXISTS hht_engine.hht_pages (
  id serial PRIMARY KEY,
  url text NOT NULL,
  page_type text NOT NULL,
  city text,
  state text,
  collection text,
  verified_stay_count integer NOT NULL DEFAULT 0,
  title text,
  last_synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hht_pages_url_idx ON hht_engine.hht_pages (url);

CREATE TABLE IF NOT EXISTS hht_engine.serp_scans (
  id serial PRIMARY KEY,
  keyword_id integer NOT NULL,
  band integer NOT NULL,
  display_offset integer NOT NULL,
  display_limit integer NOT NULL,
  units_spent integer,
  new_qualified_domains integer NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hht_engine.serp_results (
  id serial PRIMARY KEY,
  keyword_id integer NOT NULL,
  scan_id integer NOT NULL,
  url text NOT NULL,
  canonical_url text NOT NULL,
  root_domain text NOT NULL,
  position integer NOT NULL,
  band integer NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hht_engine.domains (
  id serial PRIMARY KEY,
  root_domain text NOT NULL,
  display_name text,
  site_type text NOT NULL DEFAULT 'unknown',
  primary_topic text,
  semrush_authority_score integer,
  guest_post_status text,
  guest_post_confidence double precision,
  guest_post_evidence_url text,
  guest_post_requirements text,
  sells_placements boolean NOT NULL DEFAULT false,
  filter_status text,
  filter_reasons jsonb,
  contact_status text,
  blocked boolean NOT NULL DEFAULT false,
  manual_notes text,
  first_discovered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS domains_root_idx ON hht_engine.domains (root_domain);

CREATE TABLE IF NOT EXISTS hht_engine.opportunities (
  id serial PRIMARY KEY,
  canonical_key text NOT NULL,
  external_id text NOT NULL,
  root_domain text NOT NULL,
  type text NOT NULL,
  status text NOT NULL,
  target_hht_url text,
  secondary_hht_url text,
  match_rule text,
  match_confidence double precision,
  weak_target_match boolean NOT NULL DEFAULT false,
  no_hht_city_page boolean NOT NULL DEFAULT false,
  source_keyword text,
  discovered_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS opportunities_key_idx ON hht_engine.opportunities (canonical_key);

CREATE TABLE IF NOT EXISTS hht_engine.jobs (
  id serial PRIMARY KEY,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_after timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_idx ON hht_engine.jobs (idempotency_key);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON hht_engine.jobs (status, run_after);

CREATE TABLE IF NOT EXISTS hht_engine.system_state (
  id integer PRIMARY KEY,
  semrush_state text NOT NULL DEFAULT 'RUNNING',
  gads_state text NOT NULL DEFAULT 'GADS_RUNNING',
  semrush_paused_at timestamptz,
  units_used integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO hht_engine.system_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS hht_engine.notifications (
  id serial PRIMARY KEY,
  channel text NOT NULL,
  payload text NOT NULL,
  delivery_result text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hht_engine.semrush_usage (
  id serial PRIMARY KEY,
  report text NOT NULL,
  units integer,
  job_id integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
