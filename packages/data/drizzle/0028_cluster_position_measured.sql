ALTER TABLE "keyword_clusters"
  ADD COLUMN IF NOT EXISTS "position_measured" boolean DEFAULT false NOT NULL;

-- Whether ANY member's position was actually looked up.
--
-- ==================== WHY A COLUMN AND NOT `best_position IS NOT NULL` ====
-- The first version of runClusterVerdicts derived it exactly that way, which
-- makes "we checked every member and none of them rank" indistinguishable from
-- "nobody has ever asked". Those are the two states this entire system exists to
-- keep apart, and the consequence here is concrete: Search Console silence for a
-- keyword is the measurement that turns UNKNOWN into BUILD, so a derived flag
-- would leave every not-yet-ranking cluster stuck at UNKNOWN forever — exactly
-- the clusters most worth building.
-- =========================================================================
