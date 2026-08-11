-- SERP winnability on sweep cells.
--
-- Every column is NULLABLE and null means NOT COMPUTED -- never "easy". A zero
-- difficulty would sort to the top of an easiest-first table and read as the
-- best opportunity on the page, which is the same trap scan_targets.difficulty
-- already avoids.

ALTER TABLE "discovery_serp_metrics"
  ADD COLUMN IF NOT EXISTS "difficulty" integer,
  ADD COLUMN IF NOT EXISTS "weight_covered" double precision,
  ADD COLUMN IF NOT EXISTS "difficulty_components" jsonb,
  ADD COLUMN IF NOT EXISTS "slots_open" integer,
  ADD COLUMN IF NOT EXISTS "platform_held_slots" integer,
  ADD COLUMN IF NOT EXISTS "median_ref_domains" integer,
  ADD COLUMN IF NOT EXISTS "min_ref_domains" integer,
  ADD COLUMN IF NOT EXISTS "exact_match_homepages_top5" integer,
  ADD COLUMN IF NOT EXISTS "local_businesses_top5_dedicated" integer,
  ADD COLUMN IF NOT EXISTS "link_data_measured" boolean,
  -- Two verdicts, because they genuinely disagree: registering a fresh
  -- exact-match domain is gated on that domain being available, and acquiring
  -- one is not.
  ADD COLUMN IF NOT EXISTS "verdict_emd" text,
  ADD COLUMN IF NOT EXISTS "blockers_emd" jsonb,
  ADD COLUMN IF NOT EXISTS "verdict_acquired" text,
  ADD COLUMN IF NOT EXISTS "blockers_acquired" jsonb,
  ADD COLUMN IF NOT EXISTS "emd_domain" text,
  ADD COLUMN IF NOT EXISTS "emd_available" boolean,
  ADD COLUMN IF NOT EXISTS "winnability_computed_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "discovery_serp_metrics_difficulty_idx"
  ON "discovery_serp_metrics" ("run_id", "difficulty");

-- A median over an even-length list is fractional: real values include 287.5
-- and 2552.5. Integer here rejected the write outright (22P02). Rounding would
-- have been the wrong fix -- the half is the measurement.
ALTER TABLE "discovery_serp_metrics"
  ALTER COLUMN "median_ref_domains" TYPE double precision;
