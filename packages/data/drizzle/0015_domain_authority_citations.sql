-- Authority-citation audit results on domain candidates. Purely additive.

ALTER TABLE "domain_candidates"
  ADD COLUMN IF NOT EXISTS "authority_score" integer,
  ADD COLUMN IF NOT EXISTS "authority_kinds" jsonb,
  ADD COLUMN IF NOT EXISTS "authority_matches" jsonb,
  -- Distinguishes "checked, found nothing" from "never checked" and from
  -- "skipped by the cost pre-filter". A blank column must never read as a
  -- finding.
  ADD COLUMN IF NOT EXISTS "authority_note" text,
  ADD COLUMN IF NOT EXISTS "authority_checked_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "domain_rank" integer;

CREATE INDEX IF NOT EXISTS "domain_candidates_authority_idx"
  ON "domain_candidates" ("run_id", "authority_score");
