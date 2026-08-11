-- Richer SERP layout for board research: map, LSA (≠ paid search), GBP slots, forums.
ALTER TABLE discovery_serp_metrics
  ADD COLUMN IF NOT EXISTS map_present boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS map_rank_absolute integer,
  ADD COLUMN IF NOT EXISTS lsa_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lsa_above_organic_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lsa_rank_absolute integer,
  ADD COLUMN IF NOT EXISTS local_business_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS local_business_above_organic_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS local_pack_rank_absolute integer,
  ADD COLUMN IF NOT EXISTS forums_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS forums_rank_absolute integer,
  ADD COLUMN IF NOT EXISTS best_reddit_rank_absolute integer,
  ADD COLUMN IF NOT EXISTS sponsored_above_organic_count integer NOT NULL DEFAULT 0;
