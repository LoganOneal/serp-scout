-- Local volume is free now (Google Ads), so the default flips.
--
-- It was off because DataForSEO charged $0.09 per market. That fallback is
-- removed: volume comes from Google Ads or it is null, and both cost nothing.
-- Leaving it off meant an operator paid nothing to skip it and lost the Vol
-- column, the Reddit-volume estimate, and the likely_30d winnability band,
-- which requires a measured volume >= 50.
--
-- fetch_maps deliberately stays FALSE: that one still costs $0.002 per cell.
ALTER TABLE "discovery_runs" ALTER COLUMN "fetch_volume" SET DEFAULT true;
