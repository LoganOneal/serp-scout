-- Google Ads measured volume on exact SERP queries (not population-modelled demand).
ALTER TABLE "discovery_serp_metrics" ADD COLUMN IF NOT EXISTS "avg_monthly_searches" integer;
ALTER TABLE "discovery_serp_metrics" ADD COLUMN IF NOT EXISTS "volume_source" text;
ALTER TABLE "discovery_serp_metrics" ADD COLUMN IF NOT EXISTS "volume_geo_target" text;
