-- Keyword volume cache: makes /keywords_data/google_ads/search_volume/live
-- batchable. That endpoint is $0.09 PER REQUEST and takes up to 1000 keywords;
-- the runner was spending it one keyword at a time from separate invocations
-- because there was nowhere to keep a batch result. See schema.ts.
--
-- Additive only. Nothing reads or writes existing tables.

CREATE TABLE IF NOT EXISTS keyword_volume_cache (
  id                            serial PRIMARY KEY,
  keyword                       text NOT NULL,
  location_code                 integer NOT NULL,
  language_code                 text NOT NULL DEFAULT 'en',
  avg_monthly_searches          integer,
  competition_index             integer,
  competition                   text,
  cpc_micros                    bigint,
  low_top_of_page_bid_micros    bigint,
  high_top_of_page_bid_micros   bigint,
  monthly_searches              jsonb,
  source                        text NOT NULL,
  geo_target                    text,
  -- A keyword with no data still cost us the request; cache the miss.
  has_data                      boolean NOT NULL DEFAULT true,
  fetched_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS keyword_volume_cache_key_idx
  ON keyword_volume_cache (keyword, location_code, language_code);

CREATE INDEX IF NOT EXISTS keyword_volume_cache_fresh_idx
  ON keyword_volume_cache (location_code, fetched_at);
