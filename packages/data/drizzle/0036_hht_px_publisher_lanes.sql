ALTER TABLE "hht_px_prospect_domains" ADD COLUMN IF NOT EXISTS "publisher_lane" text;
ALTER TABLE "hht_px_prospect_domains" ADD COLUMN IF NOT EXISTS "publisher_reason" text;
ALTER TABLE "hht_px_prospect_domains" ADD COLUMN IF NOT EXISTS "publisher_evidence" text;
ALTER TABLE "hht_px_prospect_domains" ADD COLUMN IF NOT EXISTS "contact_url" text;
ALTER TABLE "hht_px_prospect_domains" ADD COLUMN IF NOT EXISTS "classified_at" timestamp with time zone;

ALTER TABLE "hht_px_prospect_pages" ADD COLUMN IF NOT EXISTS "publisher_lane" text;
ALTER TABLE "hht_px_prospect_pages" ADD COLUMN IF NOT EXISTS "qualification" text;
ALTER TABLE "hht_px_prospect_pages" ADD COLUMN IF NOT EXISTS "qualification_reason" text;
ALTER TABLE "hht_px_prospect_pages" ADD COLUMN IF NOT EXISTS "editorial_score" double precision;
ALTER TABLE "hht_px_prospect_pages" ADD COLUMN IF NOT EXISTS "feasibility_score" double precision;
ALTER TABLE "hht_px_prospect_pages" ADD COLUMN IF NOT EXISTS "insertion_location" text;
ALTER TABLE "hht_px_prospect_pages" ADD COLUMN IF NOT EXISTS "reader_benefit" text;
ALTER TABLE "hht_px_prospect_pages" ADD COLUMN IF NOT EXISTS "evidence_confidence" text;
ALTER TABLE "hht_px_prospect_pages" ADD COLUMN IF NOT EXISTS "score_detail" text;
