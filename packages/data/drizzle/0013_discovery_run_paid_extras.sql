-- Per-run switches for the two paid extras layered on top of the SERP.
--
-- Both default FALSE: on a wide screen they cost more than the SERPs they
-- annotate (50kw x 50mkt = $5.00 of SERP, $4.50 of volume, $5.00 of maps), and
-- neither earns that at screening time -- national Google Ads volume is already
-- on `niches`, and nothing scores off the maps fields. See schema.ts.
--
-- Existing rows get TRUE so historical runs still describe what they bought.

ALTER TABLE discovery_runs
  ADD COLUMN IF NOT EXISTS fetch_volume boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fetch_maps   boolean NOT NULL DEFAULT false;

UPDATE discovery_runs SET fetch_volume = true, fetch_maps = true
 WHERE created_at < now();
