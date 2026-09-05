CREATE TABLE IF NOT EXISTS om_keywords (
  id serial PRIMARY KEY,
  keyword text NOT NULL,
  normalized_keyword text NOT NULL,
  country text NOT NULL DEFAULT 'us',
  volume integer,
  cpc double precision,
  competition double precision,
  keyword_difficulty double precision,
  intent text NOT NULL DEFAULT 'unknown',
  results bigint,
  trend text,
  source_type text NOT NULL,
  source_id text,
  metrics_source text NOT NULL DEFAULT 'unknown',
  metrics_fetched_at timestamptz,
  expanded_at timestamptz,
  expansion_priority double precision,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS om_keywords_norm_country_uq ON om_keywords (normalized_keyword, country);
CREATE INDEX IF NOT EXISTS om_keywords_priority_idx ON om_keywords (expansion_priority);
CREATE INDEX IF NOT EXISTS om_keywords_source_idx ON om_keywords (source_type);

CREATE TABLE IF NOT EXISTS om_keyword_monthly_volume (
  id serial PRIMARY KEY,
  keyword_id integer NOT NULL REFERENCES om_keywords(id) ON DELETE CASCADE,
  year integer NOT NULL,
  month integer NOT NULL,
  volume integer NOT NULL,
  source text NOT NULL DEFAULT 'semrush'
);
CREATE UNIQUE INDEX IF NOT EXISTS om_keyword_monthly_volume_uq ON om_keyword_monthly_volume (keyword_id, year, month, source);

CREATE TABLE IF NOT EXISTS om_keyword_edges (
  id serial PRIMARY KEY,
  source_keyword_id integer NOT NULL REFERENCES om_keywords(id) ON DELETE CASCADE,
  target_keyword_id integer NOT NULL REFERENCES om_keywords(id) ON DELETE CASCADE,
  relation_type text NOT NULL,
  depth integer NOT NULL DEFAULT 0,
  seed_family text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS om_keyword_edges_uq ON om_keyword_edges (source_keyword_id, target_keyword_id, relation_type);
CREATE INDEX IF NOT EXISTS om_keyword_edges_source_idx ON om_keyword_edges (source_keyword_id);

CREATE TABLE IF NOT EXISTS om_keyword_concepts (
  keyword_id integer PRIMARY KEY REFERENCES om_keywords(id) ON DELETE CASCADE,
  workflow text,
  industry text,
  persona text,
  object text,
  product_archetype text,
  commercial_intent integer NOT NULL,
  recurring_usage_likelihood integer NOT NULL,
  confidence text NOT NULL,
  source text NOT NULL DEFAULT 'rules',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS om_domains (
  id serial PRIMARY KEY,
  domain text NOT NULL,
  authority_score double precision,
  estimated_organic_traffic integer,
  estimated_paid_traffic integer,
  referring_domains integer,
  classification text NOT NULL DEFAULT 'unknown',
  organic_keywords integer,
  paid_keywords integer,
  overview_fetched_at timestamptz,
  reverse_mined_at timestamptz,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS om_domains_domain_uq ON om_domains (domain);

CREATE TABLE IF NOT EXISTS om_keyword_domains (
  id serial PRIMARY KEY,
  keyword_id integer NOT NULL REFERENCES om_keywords(id) ON DELETE CASCADE,
  domain_id integer NOT NULL REFERENCES om_domains(id) ON DELETE CASCADE,
  ranking_type text NOT NULL,
  position integer,
  url text,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS om_keyword_domains_uq ON om_keyword_domains (keyword_id, domain_id, ranking_type);
CREATE INDEX IF NOT EXISTS om_keyword_domains_domain_idx ON om_keyword_domains (domain_id);

CREATE TABLE IF NOT EXISTS om_ads (
  id serial PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES om_domains(id) ON DELETE CASCADE,
  keyword_id integer REFERENCES om_keywords(id) ON DELETE SET NULL,
  ad_title text,
  ad_text text,
  visible_url text,
  date_seen text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS om_ads_domain_idx ON om_ads (domain_id, keyword_id);

CREATE TABLE IF NOT EXISTS om_markets (
  id serial PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  canonical_problem text,
  likely_customer text,
  business_type text NOT NULL DEFAULT 'unknown',
  monetization_model text NOT NULL DEFAULT 'unknown',
  buyer_type text NOT NULL DEFAULT 'unknown',
  cluster_key text,
  thesis text,
  business_idea text,
  risks text,
  expansion_notes text,
  discovery_path text,
  status text NOT NULL DEFAULT 'new',
  rejection_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  score_override double precision,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  country text NOT NULL DEFAULT 'us',
  raw_volume integer,
  adjusted_volume integer,
  weighted_cpc double precision,
  weighted_kd double precision,
  median_kd double precision,
  commercial_volume integer,
  high_intent_volume integer,
  branded_share double precision,
  growth_3m double precision,
  growth_6m double precision,
  growth_12m double precision,
  growth_24m double precision,
  unique_advertisers integer NOT NULL DEFAULT 0,
  persistent_advertisers integer NOT NULL DEFAULT 0,
  competitor_count integer NOT NULL DEFAULT 0,
  serp_weakness double precision,
  recurring_usage integer,
  willingness_to_pay integer,
  expansion_potential integer,
  build_complexity integer,
  llm_confidence text NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS om_markets_slug_uq ON om_markets (slug);
CREATE INDEX IF NOT EXISTS om_markets_status_idx ON om_markets (status);
CREATE INDEX IF NOT EXISTS om_markets_cluster_key_idx ON om_markets (cluster_key);

CREATE TABLE IF NOT EXISTS om_market_keywords (
  market_id integer NOT NULL REFERENCES om_markets(id) ON DELETE CASCADE,
  keyword_id integer NOT NULL REFERENCES om_keywords(id) ON DELETE CASCADE,
  relevance_score double precision NOT NULL DEFAULT 1,
  intent_score double precision
);
CREATE UNIQUE INDEX IF NOT EXISTS om_market_keywords_uq ON om_market_keywords (market_id, keyword_id);
CREATE INDEX IF NOT EXISTS om_market_keywords_kw_idx ON om_market_keywords (keyword_id);

CREATE TABLE IF NOT EXISTS om_market_domains (
  market_id integer NOT NULL REFERENCES om_markets(id) ON DELETE CASCADE,
  domain_id integer NOT NULL REFERENCES om_domains(id) ON DELETE CASCADE,
  role text NOT NULL,
  relevance_score double precision NOT NULL DEFAULT 1,
  keyword_count integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS om_market_domains_uq ON om_market_domains (market_id, domain_id, role);

CREATE TABLE IF NOT EXISTS om_opportunity_economics (
  market_id integer PRIMARY KEY REFERENCES om_markets(id) ON DELETE CASCADE,
  estimated_monthly_price_bear double precision,
  estimated_monthly_price_base double precision,
  estimated_monthly_price_bull double precision,
  estimated_lifetime_months_bear double precision,
  estimated_lifetime_months_base double precision,
  estimated_lifetime_months_bull double precision,
  gross_margin_bear double precision,
  gross_margin_base double precision,
  gross_margin_bull double precision,
  click_to_paid_bear double precision,
  click_to_paid_base double precision,
  click_to_paid_bull double precision,
  gross_profit_ltv_bear double precision,
  gross_profit_ltv_base double precision,
  gross_profit_ltv_bull double precision,
  allowable_cac_bear double precision,
  allowable_cac_base double precision,
  allowable_cac_bull double precision,
  sustainable_cpc_bear double precision,
  sustainable_cpc_base double precision,
  sustainable_cpc_bull double precision,
  observed_weighted_cpc double precision,
  cpc_coverage_bear double precision,
  cpc_coverage_base double precision,
  cpc_coverage_bull double precision,
  observed_low_price double precision,
  observed_median_price double precision,
  observed_high_price double precision,
  pricing_observation_count integer NOT NULL DEFAULT 0,
  price_confidence text NOT NULL DEFAULT 'unknown',
  lifetime_confidence text NOT NULL DEFAULT 'weakly_inferred',
  organic_clicks_base double precision,
  estimated_monthly_new_ltv double precision,
  seo_economic_score double precision,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS om_market_scores (
  market_id integer PRIMARY KEY REFERENCES om_markets(id) ON DELETE CASCADE,
  demand_score double precision NOT NULL,
  commercial_intent_score double precision NOT NULL,
  monetization_evidence_score double precision NOT NULL,
  willingness_to_pay_score double precision NOT NULL,
  recurring_usage_score double precision NOT NULL,
  expansion_score double precision NOT NULL,
  seo_accessibility_score double precision NOT NULL,
  paid_acquisition_score double precision NOT NULL,
  competitor_weakness_score double precision NOT NULL,
  growth_score double precision NOT NULL,
  build_feasibility_score double precision NOT NULL,
  total_score double precision NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS om_pricing_observations (
  id serial PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES om_domains(id) ON DELETE CASCADE,
  market_id integer REFERENCES om_markets(id) ON DELETE SET NULL,
  source_url text,
  free_tier boolean,
  cheapest_paid double precision,
  popular_plan double precision,
  highest_self_serve double precision,
  annual boolean,
  per_seat boolean,
  usage_based boolean,
  enterprise_only boolean,
  raw_excerpt text,
  confidence text NOT NULL DEFAULT 'observed',
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS om_anomalies (
  id serial PRIMARY KEY,
  market_id integer NOT NULL REFERENCES om_markets(id) ON DELETE CASCADE,
  kind text NOT NULL,
  why text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS om_anomalies_uq ON om_anomalies (market_id, kind);
CREATE INDEX IF NOT EXISTS om_anomalies_kind_idx ON om_anomalies (kind);

CREATE TABLE IF NOT EXISTS om_queue (
  id serial PRIMARY KEY,
  job_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  priority double precision NOT NULL DEFAULT 0,
  depth integer NOT NULL DEFAULT 0,
  seed_family text,
  keyword_id integer REFERENCES om_keywords(id) ON DELETE CASCADE,
  domain_id integer REFERENCES om_domains(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  error text,
  claimed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS om_queue_pending_idx ON om_queue (status, priority);
CREATE INDEX IF NOT EXISTS om_queue_keyword_idx ON om_queue (keyword_id, job_type);

CREATE TABLE IF NOT EXISTS om_semrush_cache (
  id serial PRIMARY KEY,
  cache_key text NOT NULL,
  report text NOT NULL,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS om_semrush_cache_key_uq ON om_semrush_cache (cache_key);

CREATE TABLE IF NOT EXISTS om_runs (
  id serial PRIMARY KEY,
  command text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  notes text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS om_run_events (
  id serial PRIMARY KEY,
  run_id integer REFERENCES om_runs(id) ON DELETE CASCADE,
  channel text NOT NULL,
  message text NOT NULL,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
