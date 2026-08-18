-- Clusters: the unit of work is a page, not a keyword.
--
-- ==================== WHY THIS IS NOT JUST A COLUMN ====================
-- `hotels with jacuzzi in room houston`, `houston hotels with hot tub in room`
-- and `in room jacuzzi suites in houston tx` are one page. The grid produces
-- three independent BUILD verdicts, three value estimates, and no notion of
-- which one the title should target. The queue overstates the work and the
-- prize overstates the prize.
-- =======================================================================
--
-- ==================== AND WHY VOLUME IS TWO COLUMNS ====================
-- Measured on the imported export: 3,090 rows carry 2,359 distinct keywords, and
-- 109 of those report the SAME volume as a longer or shorter variant of
-- themselves. Four rows all reporting 590:
--
--     hot tub hotel rooms            hot tub hotel rooms near me
--     hotels near me with hot tubs   hotels near me with hot tubs in room
--
-- Summed, that is 2,360 claimed for ~590 of real demand. Per city the inflation
-- measured 4.5x (Las Vegas), 7.3x (Houston), 11.2x (Chicago) — and because it is
-- UNEVEN it reorders the cities rather than merely inflating them.
--
-- So `volume_max` is the ranking number and a genuine lower bound; `volume_sum`
-- is stored, labelled an upper bound, and never sorted on.
-- =======================================================================

CREATE TABLE IF NOT EXISTS "keyword_clusters" (
  "id" serial PRIMARY KEY NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "slug" text NOT NULL,
  -- 'locality' | 'brand' | 'head' | 'modifier' | 'property_type' | 'vocab' | 'quarantine'
  --
  -- Load-bearing: only locality clusters bind to an entity and therefore only
  -- they inherit the supply gate. Asking whether we hold inventory for
  -- `chain_hilton` is a category error, and `n/a` there must not read as a gap.
  "kind" text NOT NULL DEFAULT 'modifier',
  "label" text NOT NULL,
  -- The head term. What a page title would actually target.
  "primary_keyword_norm" text,

  -- NULL = unresolved, never "no entity". Same rule as supply_suppliers.
  "entity_kind" text,
  "entity_slug" text,
  "unresolved_reason" text,

  "primary_url" text,
  "supporting_urls" jsonb,

  -- --- Materialised aggregates over the members ----------------------------
  "member_count" integer DEFAULT 0 NOT NULL,
  -- THE ranking number. Lower bound: demand is at least the biggest single query.
  "volume_max" integer,
  -- Upper bound. Inflated by near-duplicate phrasings. Never sort on this.
  "volume_sum" integer,
  -- Semrush's KD, on Semrush's scale. NOT this repo's scoreDifficulty, and kept
  -- in its own columns so the two can never be silently mixed.
  "kd_min" integer,
  "kd_median" integer,
  -- Best position across members: if any member ranks, the page ranks.
  "best_position" integer,

  "verdict" text,
  "verdict_reason" text,
  "verdict_missing" jsonb,

  "source" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "keyword_clusters_site_slug_uq"
  ON "keyword_clusters" ("site_id", "slug");
CREATE INDEX IF NOT EXISTS "keyword_clusters_rank_idx"
  ON "keyword_clusters" ("site_id", "kind", "volume_max" DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- Membership.
--
-- NULLABLE, and that is deliberate: an unclustered keyword is UNKNOWN-clustered,
-- not a cluster of one. Auto-promoting singletons would manufacture a thousand
-- one-keyword clusters and bury the forty that matter.

ALTER TABLE "site_keyword_targets"
  ADD COLUMN IF NOT EXISTS "cluster_id" integer
  REFERENCES "keyword_clusters"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "site_keyword_targets_cluster_idx"
  ON "site_keyword_targets" ("cluster_id");

-- Semrush's own numbers, kept beside ours rather than overwriting them.
--
-- `semrush_kd` is not `difficulty`: one is a vendor's 0-100 on their model, the
-- other is scoreDifficulty's 0-100 on ours, calibrated against local SERPs. A
-- single column would make them look comparable, and the verdict ceiling reads
-- the second one.
ALTER TABLE "site_keyword_targets"
  ADD COLUMN IF NOT EXISTS "semrush_kd" integer;
ALTER TABLE "site_keyword_targets"
  ADD COLUMN IF NOT EXISTS "semrush_volume" integer;
ALTER TABLE "site_keyword_targets"
  ADD COLUMN IF NOT EXISTS "intent" text;
-- Which Keyword Magic seed(s) produced this row. 524 of 2,359 came from more
-- than one, so this is an array rather than a column.
ALTER TABLE "site_keyword_targets"
  ADD COLUMN IF NOT EXISTS "seeds" jsonb;

-- ---------------------------------------------------------------------------
-- Import provenance.

CREATE TABLE IF NOT EXISTS "keyword_import_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "source_dir" text,
  "files" jsonb,
  "rows_read" integer DEFAULT 0 NOT NULL,
  -- rows_read - keywords_upserted is the duplicate count, and it is large:
  -- 3,090 rows carried 2,359 keywords.
  "keywords_upserted" integer DEFAULT 0 NOT NULL,
  "clusters_upserted" integer DEFAULT 0 NOT NULL,
  "unresolved_entities" integer DEFAULT 0 NOT NULL,
  "quarantined" integer DEFAULT 0 NOT NULL,
  "notes" jsonb,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "error" text
);
CREATE INDEX IF NOT EXISTS "keyword_import_runs_site_idx"
  ON "keyword_import_runs" ("site_id", "started_at" DESC);
