-- Paid search: the bid range we already bought, and plans that are not launched.
--
-- ==================== THE COST TERM WAS BEING DISCARDED ====================
-- Every free Google Ads volume call returns low/high top-of-page bid alongside
-- the search volume. `runVolumePass` stored `cpc_micros` — which is
-- DELIBERATELY NULL on the Google Ads path, because Google publishes a bid
-- RANGE and the existing code refuses to fabricate a single CPC from it:
--
--   "measured against cached DataForSEO rows, cpc/high ran 0.07x-1.16x and
--    cpc/low 0.79x-2.59x. Any single derived number would be a fabricated
--    figure in a column operators read as measured."
--
-- That refusal is right. The consequence was that the paid-search model had no
-- cost term at all. Carry the range AS A RANGE and compute break-even at both
-- ends — see @rnr/core computeBreakEven.
-- ==========================================================================

ALTER TABLE "site_keyword_targets"
  ADD COLUMN IF NOT EXISTS "bid_low_micros" bigint,
  ADD COLUMN IF NOT EXISTS "bid_high_micros" bigint;

-- ---------------------------------------------------------------------------
-- A campaign we have designed and NOT launched.
--
-- Persisted before it can be launched, so what was launched is reconstructable
-- from a row rather than from shell history. `launched_at` NULL is the normal
-- state and the only state this repo currently produces.

CREATE TABLE IF NOT EXISTS "ads_plans" (
  "id" serial PRIMARY KEY NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "name" text NOT NULL,
  -- 'draft' | 'validated' | 'launched' | 'abandoned'
  "status" text DEFAULT 'draft' NOT NULL,

  -- Economics the plan was computed against, FROZEN at plan time. The site's
  -- values can change; a plan must still explain the numbers it reported.
  "order_value_micros" bigint,
  "commission_rate_bps" integer,
  "achieved_conversion_bps" integer,

  "daily_budget_micros" bigint NOT NULL,
  -- One code for the whole campaign, mirroring keyword_space.serpLocationCode.
  "location_code" integer NOT NULL,
  "language_code" text DEFAULT 'en' NOT NULL,

  -- Google's own forecast for the plan as a whole. NULL = never asked.
  "forecast_clicks" double precision,
  "forecast_impressions" double precision,
  "forecast_cost_micros" bigint,
  "forecast_avg_cpc_micros" bigint,
  "forecast_fetched_at" timestamp with time zone,

  -- The measurement design, decided BEFORE launch. See @rnr/core experiment.ts.
  "experiment_arms" jsonb,
  "experiment_feasible" boolean,
  "experiment_verdict" text,

  -- Set only by a launch that actually happened. Nothing writes these yet.
  "google_campaign_resource" text,
  "launched_at" timestamp with time zone,
  "launched_by" text,

  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "ads_plans_site_idx" ON "ads_plans" ("site_id", "status");

CREATE TABLE IF NOT EXISTS "ads_plan_keywords" (
  "id" serial PRIMARY KEY NOT NULL,
  "plan_id" integer NOT NULL REFERENCES "ads_plans"("id") ON DELETE cascade,
  "keyword_target_id" integer REFERENCES "site_keyword_targets"("id") ON DELETE set null,
  "keyword" text NOT NULL,
  -- Google match type: 'EXACT' | 'PHRASE' | 'BROAD'
  "match_type" text DEFAULT 'EXACT' NOT NULL,
  -- Themed grouping. Comes from the grid's pattern_label for free.
  "ad_group" text NOT NULL,

  "volume" integer,
  "organic_position" integer,
  -- Which of the three published bands applied: rank1 / rank2to4 / rank5plus / noOrganic
  "incrementality_band" text,
  "incrementality_bps" integer,

  "bid_low_micros" bigint,
  "bid_high_micros" bigint,
  "max_cpc_micros" bigint,

  -- The product: what this keyword must convert at to break even.
  "required_conversion_bps_low" integer,
  "required_conversion_bps_high" integer,
  "margin_ratio" double precision,

  -- 'BUY' | 'MARGINAL' | 'SKIP' | 'BLOCKED' | 'UNKNOWN'
  "verdict" text,
  "verdict_reason" text,
  "warnings" jsonb,

  -- Allocation. 'exploit' vs 'explore' is kept so the split stays visible.
  "allocated_clicks" double precision,
  "allocated_budget_micros" bigint,
  "allocation_pot" text,

  -- Which experiment arm this keyword's destination fell into.
  "experiment_arm" text,
  "experiment_cluster" text,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "ads_plan_keywords_plan_keyword_uq"
  ON "ads_plan_keywords" ("plan_id", "keyword", "match_type");
CREATE INDEX IF NOT EXISTS "ads_plan_keywords_verdict_idx"
  ON "ads_plan_keywords" ("plan_id", "verdict");
