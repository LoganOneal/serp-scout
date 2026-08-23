-- Persisted HotelHotTubs Reddit keyword-planning snapshots.
-- These rows are deliberately separate from site_keyword_targets: discovering a
-- phrase here must never opt it into a paid SERP scan.

CREATE TABLE IF NOT EXISTS "hht_reddit_keyword_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "source_hash" text NOT NULL,
  "generated_at" timestamp with time zone NOT NULL,
  "audience_scope" text DEFAULT 'country:US' NOT NULL,
  "google_ads_geo_target" integer DEFAULT 2840 NOT NULL,
  "free_only" boolean DEFAULT true NOT NULL,
  "destination_count" integer NOT NULL,
  "ideas_returned" integer NOT NULL,
  "eligible_keyword_count" integer NOT NULL,
  "measured_keyword_count" integer NOT NULL,
  "positive_cluster_count" integer NOT NULL,
  "measured_city_count" integer NOT NULL,
  "rejections" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_reddit_keyword_runs_source_uq"
  ON "hht_reddit_keyword_runs" ("site_id", "source_hash");
CREATE INDEX IF NOT EXISTS "hht_reddit_keyword_runs_latest_idx"
  ON "hht_reddit_keyword_runs" ("site_id", "generated_at");

CREATE TABLE IF NOT EXISTS "hht_reddit_city_aggregates" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hht_reddit_keyword_runs"("id") ON DELETE cascade,
  "city_rank" integer NOT NULL,
  "city" text NOT NULL,
  "city_slug" text NOT NULL,
  "conservative_aggregate_volume" integer NOT NULL,
  "raw_aggregate_volume" integer NOT NULL,
  "close_variant_overlap_delta" integer NOT NULL,
  "keyword_count" integer NOT NULL,
  "measured_keyword_count" integer NOT NULL,
  "unmeasured_keyword_count" integer NOT NULL,
  "intent_cluster_count" integer NOT NULL,
  "top_keyword" text,
  "top_keyword_volume" integer,
  "ideas_returned" integer NOT NULL,
  "idea_source" text NOT NULL,
  "error" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_reddit_city_aggregates_city_uq"
  ON "hht_reddit_city_aggregates" ("run_id", "city_slug");
CREATE INDEX IF NOT EXISTS "hht_reddit_city_aggregates_rank_idx"
  ON "hht_reddit_city_aggregates" ("run_id", "city_rank");

CREATE TABLE IF NOT EXISTS "hht_reddit_keywords" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hht_reddit_keyword_runs"("id") ON DELETE cascade,
  "global_rank" integer NOT NULL,
  "city_rank" integer NOT NULL,
  "city" text NOT NULL,
  "city_slug" text NOT NULL,
  "keyword" text NOT NULL,
  "keyword_norm" text NOT NULL,
  "avg_monthly_searches" integer,
  "intent_tier" text NOT NULL,
  "intent_cluster" text NOT NULL,
  "competition_index" integer,
  "low_top_of_page_bid_micros" bigint,
  "high_top_of_page_bid_micros" bigint,
  "clears_volume_floor" boolean,
  "sources" jsonb NOT NULL,
  "volume_scope" text DEFAULT 'us/en' NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_reddit_keywords_keyword_uq"
  ON "hht_reddit_keywords" ("run_id", "city_slug", "keyword_norm");
CREATE INDEX IF NOT EXISTS "hht_reddit_keywords_city_rank_idx"
  ON "hht_reddit_keywords" ("run_id", "city_slug", "city_rank");
CREATE INDEX IF NOT EXISTS "hht_reddit_keywords_volume_idx"
  ON "hht_reddit_keywords" ("run_id", "avg_monthly_searches");
