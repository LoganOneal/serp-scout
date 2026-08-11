-- Provenance and quality gates for domain candidates. Purely additive.

ALTER TABLE "domain_candidates"
  -- Where this domain was seen: organic | map_pack | maps_live | serp_store
  ADD COLUMN IF NOT EXISTS "sources" jsonb,
  -- Best organic rank_absolute observed. A domain ranking at #3 that is dead
  -- is worth more than an identical one nobody can find.
  ADD COLUMN IF NOT EXISTS "serp_rank" integer,
  -- Which query surfaced it, for audit.
  ADD COLUMN IF NOT EXISTS "seen_keyword" text,
  -- Paid gates. NULL means "not checked", never "clean".
  ADD COLUMN IF NOT EXISTS "spam_score" integer,
  ADD COLUMN IF NOT EXISTS "ranked_keywords" integer,
  ADD COLUMN IF NOT EXISTS "quality_checked_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "domain_candidates_serp_rank_idx"
  ON "domain_candidates" ("run_id", "serp_rank");

ALTER TABLE "domain_enrich_runs"
  -- Which optional paid stages the operator turned on for this run.
  ADD COLUMN IF NOT EXISTS "paid_options" jsonb,
  ADD COLUMN IF NOT EXISTS "domains_from_serps" integer DEFAULT 0 NOT NULL;

-- Optional niche scope for the free SERP harvest. NULL means "the whole
-- market", which is the wider net and the default.
ALTER TABLE "domain_enrich_runs"
  ADD COLUMN IF NOT EXISTS "niche_id" integer;
