ALTER TABLE "hht_reddit_keyword_runs"
  ALTER COLUMN "google_ads_geo_target" DROP NOT NULL;

ALTER TABLE "hht_reddit_city_aggregates"
  ADD COLUMN IF NOT EXISTS "country_code" text NOT NULL DEFAULT 'US',
  ADD COLUMN IF NOT EXISTS "google_ads_geo_target" integer NOT NULL DEFAULT 2840,
  ADD COLUMN IF NOT EXISTS "volume_scope" text NOT NULL DEFAULT 'us/en';

ALTER TABLE "hht_reddit_keywords"
  ADD COLUMN IF NOT EXISTS "country_code" text NOT NULL DEFAULT 'US',
  ADD COLUMN IF NOT EXISTS "google_ads_geo_target" integer NOT NULL DEFAULT 2840;

CREATE INDEX IF NOT EXISTS "hht_reddit_city_aggregates_country_rank_idx"
  ON "hht_reddit_city_aggregates" ("run_id", "country_code", "city_rank");

CREATE INDEX IF NOT EXISTS "hht_reddit_keywords_country_volume_idx"
  ON "hht_reddit_keywords" ("run_id", "country_code", "avg_monthly_searches");
