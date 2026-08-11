-- Optionally measure "<keyword> <city>" alongside the city-free keyword.
--
-- The sweep measures city-free keywords and passes geo as location_code. That
-- is the right signal for rank-and-rent: it shows who holds the local slots.
-- It is the wrong signal for the Reddit play. "plumber" at location_code
-- 1023191 (New York City) returns a Perspectives module holding r/AusRenovation,
-- r/roanoke and r/askaplumber -- real page-1 placements, none of them New York
-- leads. The city-specific threads live on the string people actually type.
--
-- DEFAULT FALSE: this adds one SERP per keyword x geo x device, so a run that
-- turns it on doubles its SERP count (or triples, with near_me also on). The
-- flag is per run rather than a global setting so the cost is chosen each time.
ALTER TABLE "discovery_runs"
  ADD COLUMN IF NOT EXISTS "include_geo_explicit" boolean NOT NULL DEFAULT false;
