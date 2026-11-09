-- SERP surface coverage: which blocks a query returns, and whether we hold one.
--
-- ==================== WE ALREADY BOUGHT THIS AND THREW IT AWAY ============
-- runDifficultyPass calls extractSerpLayoutMetrics on every SERP it purchases --
-- discussions pack, maps, images, video, paid, LSA, AI Overview, People Also
-- Ask, and the raw itemTypes list -- and then stored exactly one field of it:
-- hasAiOverview. The SERP was already paid for; the surfaces were already
-- extracted; nineteen of twenty fields were discarded on the way to the database.
-- =========================================================================
--
-- ==================== ONE ROW PER SURFACE, NOT TWENTY COLUMNS =============
-- Surfaces come and go as Google changes -- ai_overview, discussions_and_forums
-- and perspectives all postdate this pipeline. A row-per-surface absorbs a new
-- one with no migration, and it is what makes "when did we lose the discussions
-- pack" answerable at all; a wide current-state table cannot answer it.
-- =========================================================================

CREATE TABLE IF NOT EXISTS "serp_surface_observations" (
  "id" serial PRIMARY KEY NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "keyword_norm" text NOT NULL,
  "cluster_id" integer REFERENCES "keyword_clusters"("id") ON DELETE set null,

  -- A SERP is a snapshot from ONE location on ONE device. Surfaces differ by
  -- both, so observations are never compared across them.
  "location_code" integer,
  "device" text DEFAULT 'desktop',

  -- 'organic' | 'discussions' | 'images' | 'video' | 'paa' | 'ai_overview'
  -- | 'maps' | 'paid' | 'top_stories' | 'shopping'
  "surface" text NOT NULL,

  -- ==================== present + our_rank ENCODE FOUR STATES ============
  --   present = false                -> ABSENT      (nothing to win here)
  --   present = true, our_rank NULL   -> THEIRS     (go compete)
  --   our_rank set                    -> HELD
  --   no row at all                   -> UNMEASURED (go buy a SERP)
  --
  -- Three of those look like "no" and mean completely different things, which
  -- is why this is two columns and an absence rather than one nullable enum.
  -- ======================================================================
  "present" boolean NOT NULL DEFAULT false,
  "our_rank" integer,
  "our_url" text,
  -- Who does hold it. Answers "who am I actually competing with here".
  "holder_domains" jsonb,
  -- Where the block sits on the page. #1 organic under an AI Overview, a Maps
  -- pack and a video carousel is not #1 in any sense a searcher experiences.
  "block_rank_absolute" integer,

  "measured_at" timestamp with time zone DEFAULT now() NOT NULL,
  "source" text
);

-- One current row per (site, keyword, surface, device). History is kept by
-- measured_at on the same key being upserted -- see the note on bump charts in
-- docs/plan-serp-coverage.md; a second sweep overwrites rather than appends
-- until that view exists and needs the series.
CREATE UNIQUE INDEX IF NOT EXISTS "serp_surface_obs_uq"
  ON "serp_surface_observations" ("site_id", "keyword_norm", "surface", "device");
CREATE INDEX IF NOT EXISTS "serp_surface_obs_cluster_idx"
  ON "serp_surface_observations" ("cluster_id", "surface");
CREATE INDEX IF NOT EXISTS "serp_surface_obs_site_idx"
  ON "serp_surface_observations" ("site_id", "measured_at" DESC);
