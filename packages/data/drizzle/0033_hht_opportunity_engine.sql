CREATE TABLE IF NOT EXISTS hht_opp_settings (
  id serial PRIMARY KEY,
  score_weights jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hht_opp_discovery_runs (
  id serial PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  notes text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS hht_opp_search_queries (
  id serial PRIMARY KEY,
  run_id integer REFERENCES hht_opp_discovery_runs(id) ON DELETE CASCADE,
  query text NOT NULL,
  strategy text NOT NULL,
  family text,
  results_found integer NOT NULL DEFAULT 0,
  new_domains integer NOT NULL DEFAULT 0,
  qualified_domains integer NOT NULL DEFAULT 0,
  pass_domains integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hht_opp_search_queries_strategy_idx ON hht_opp_search_queries (strategy, created_at);
CREATE INDEX IF NOT EXISTS hht_opp_search_queries_query_idx ON hht_opp_search_queries (query);

CREATE TABLE IF NOT EXISTS hht_opp_domains (
  id serial PRIMARY KEY,
  root_domain text NOT NULL,
  display_name text,
  canonical_url text,
  quality text NOT NULL DEFAULT 'OK',
  quality_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  avg_external_links double precision,
  unique_external_domains integer,
  avg_internal_links double precision,
  external_to_internal_ratio double precision,
  commercial_link_density double precision,
  outbound_sample_size integer,
  already_links_to_hht boolean,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hht_opp_domains_root_uq ON hht_opp_domains (root_domain);

CREATE TABLE IF NOT EXISTS hht_opp_discovered_domains (
  id serial PRIMARY KEY,
  query_id integer REFERENCES hht_opp_search_queries(id) ON DELETE CASCADE,
  domain_id integer NOT NULL REFERENCES hht_opp_domains(id) ON DELETE CASCADE,
  seed_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hht_opp_discovered_domains_uq ON hht_opp_discovered_domains (query_id, domain_id);

CREATE TABLE IF NOT EXISTS hht_opp_opportunities (
  id serial PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES hht_opp_domains(id) ON DELETE CASCADE,
  opportunity_type text NOT NULL,
  invented_type jsonb,
  opportunity_url text NOT NULL,
  status text NOT NULL DEFAULT 'NEW',
  eligibility text NOT NULL DEFAULT 'REVIEW',
  eligibility_reason text NOT NULL,
  eligibility_confidence text NOT NULL DEFAULT 'LOW',
  eligibility_source_url text,
  eligibility_excerpt text,
  eligibility_checked_at timestamptz,
  link_type text NOT NULL DEFAULT 'unknown',
  seo_risk text NOT NULL DEFAULT 'LOW',
  seo_risk_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  price_status text NOT NULL DEFAULT 'UNKNOWN',
  price_amount double precision,
  price_currency text,
  pricing_model text NOT NULL DEFAULT 'unspecified',
  price_evidence_url text,
  price_evidence_text text,
  price_checked_at timestamptz,
  requirements_summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  why_it_matters text,
  pitch_angle text,
  relevant_article_url text,
  broken_url text,
  replacement_url text,
  discovered_by_strategy text NOT NULL DEFAULT 'manual_seed',
  contacted boolean NOT NULL DEFAULT false,
  requirements_changed boolean NOT NULL DEFAULT false,
  feasibility_score double precision,
  seo_value_score double precision,
  topical_relevance_score double precision,
  editorial_quality_score double precision,
  cost_efficiency_score double precision,
  freshness_score double precision,
  overall_score double precision,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hht_opp_opportunities_dedupe_uq ON hht_opp_opportunities (domain_id, opportunity_type, opportunity_url);
CREATE INDEX IF NOT EXISTS hht_opp_opportunities_status_idx ON hht_opp_opportunities (status, overall_score);
CREATE INDEX IF NOT EXISTS hht_opp_opportunities_type_idx ON hht_opp_opportunities (opportunity_type);

CREATE TABLE IF NOT EXISTS hht_opp_requirements (
  id serial PRIMARY KEY,
  opportunity_id integer NOT NULL REFERENCES hht_opp_opportunities(id) ON DELETE CASCADE,
  group_name text NOT NULL,
  label text NOT NULL,
  requirement_text text NOT NULL,
  source_url text NOT NULL,
  source_excerpt text NOT NULL,
  date_checked timestamptz NOT NULL DEFAULT now(),
  confidence text NOT NULL DEFAULT 'MEDIUM'
);
CREATE INDEX IF NOT EXISTS hht_opp_requirements_opp_idx ON hht_opp_requirements (opportunity_id, group_name);

CREATE TABLE IF NOT EXISTS hht_opp_sources (
  id serial PRIMARY KEY,
  opportunity_id integer NOT NULL REFERENCES hht_opp_opportunities(id) ON DELETE CASCADE,
  url text NOT NULL,
  title text,
  role text NOT NULL,
  excerpt text,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hht_opp_pricing_options (
  id serial PRIMARY KEY,
  opportunity_id integer NOT NULL REFERENCES hht_opp_opportunities(id) ON DELETE CASCADE,
  label text,
  amount double precision,
  currency text,
  pricing_model text NOT NULL DEFAULT 'unspecified',
  included text,
  link_attribute text,
  evidence_url text NOT NULL,
  evidence_text text,
  date_checked timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hht_opp_contacts (
  id serial PRIMARY KEY,
  opportunity_id integer NOT NULL REFERENCES hht_opp_opportunities(id) ON DELETE CASCADE,
  email text,
  name text,
  role text,
  form_url text,
  status text NOT NULL DEFAULT 'UNKNOWN',
  source_url text NOT NULL,
  source_excerpt text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hht_opp_drafts (
  id serial PRIMARY KEY,
  opportunity_id integer NOT NULL REFERENCES hht_opp_opportunities(id) ON DELETE CASCADE,
  subject text NOT NULL,
  body text NOT NULL,
  pitch_angle text,
  article_ideas jsonb NOT NULL DEFAULT '[]'::jsonb,
  tone text NOT NULL DEFAULT 'default',
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hht_opp_drafts_opp_idx ON hht_opp_drafts (opportunity_id, created_at);

CREATE TABLE IF NOT EXISTS hht_opp_seo_metrics (
  id serial PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES hht_opp_domains(id) ON DELETE CASCADE,
  metric text NOT NULL,
  value double precision,
  source text NOT NULL DEFAULT 'semrush',
  retrieved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hht_opp_seo_metrics_domain_idx ON hht_opp_seo_metrics (domain_id, metric, retrieved_at);

CREATE TABLE IF NOT EXISTS hht_opp_crawled_pages (
  id serial PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES hht_opp_domains(id) ON DELETE CASCADE,
  url text NOT NULL,
  title text,
  http_status integer,
  content_hash text,
  page_text text,
  raw_html text,
  external_link_count integer,
  internal_link_count integer,
  unique_external_domains integer,
  commercial_link_count integer,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  error text
);
CREATE UNIQUE INDEX IF NOT EXISTS hht_opp_crawled_pages_url_uq ON hht_opp_crawled_pages (domain_id, url);

CREATE TABLE IF NOT EXISTS hht_opp_outreach_events (
  id serial PRIMARY KEY,
  opportunity_id integer NOT NULL REFERENCES hht_opp_opportunities(id) ON DELETE CASCADE,
  date_sent timestamptz,
  channel text,
  reply boolean,
  positive_reply boolean,
  price_quoted double precision,
  link_acquired boolean,
  link_url text,
  target_hht_url text,
  final_cost double precision,
  link_attribute text,
  live_date timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO hht_opp_settings (score_weights)
SELECT '{"seoValue":0.3,"feasibility":0.25,"topicalRelevance":0.2,"editorialQuality":0.1,"costEfficiency":0.1,"freshness":0.05}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM hht_opp_settings);
