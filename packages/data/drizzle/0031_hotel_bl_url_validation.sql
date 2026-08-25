-- Per-hotel URL validation and explicit entity-role taxonomy. Imported URLs are
-- preserved as provenance; validated redirects and canonical property identity
-- are stored separately so a tourism board is never rewritten into a hotel.

ALTER TABLE "hotel_bl_hotels"
  ADD COLUMN IF NOT EXISTS "source_entity_scope" text DEFAULT 'unknown' NOT NULL,
  ADD COLUMN IF NOT EXISTS "source_entity_type" text DEFAULT 'unknown' NOT NULL,
  ADD COLUMN IF NOT EXISTS "listing_source_url" text,
  ADD COLUMN IF NOT EXISTS "listing_final_url" text,
  ADD COLUMN IF NOT EXISTS "listing_status_code" integer,
  ADD COLUMN IF NOT EXISTS "listing_matched" boolean,
  ADD COLUMN IF NOT EXISTS "listing_address" text,
  ADD COLUMN IF NOT EXISTS "candidate_final_url" text,
  ADD COLUMN IF NOT EXISTS "url_validation_status" text,
  ADD COLUMN IF NOT EXISTS "url_validation_confidence" double precision,
  ADD COLUMN IF NOT EXISTS "url_validation_reason" text,
  ADD COLUMN IF NOT EXISTS "url_validation_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "url_validated_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "hotel_bl_hotels_validation_idx"
  ON "hotel_bl_hotels" ("source_entity_scope", "url_validation_status");

ALTER TABLE "hotel_bl_domains"
  ADD COLUMN IF NOT EXISTS "entity_scope" text DEFAULT 'unknown' NOT NULL;

ALTER TABLE "hotel_bl_relationships"
  ADD COLUMN IF NOT EXISTS "entity_scope" text DEFAULT 'unknown' NOT NULL,
  ADD COLUMN IF NOT EXISTS "entity_type" text DEFAULT 'unknown' NOT NULL,
  ADD COLUMN IF NOT EXISTS "entity_name" text,
  ADD COLUMN IF NOT EXISTS "url_validation_status" text,
  ADD COLUMN IF NOT EXISTS "url_validation_confidence" double precision,
  ADD COLUMN IF NOT EXISTS "url_validation_reason" text,
  ADD COLUMN IF NOT EXISTS "candidate_final_url" text,
  ADD COLUMN IF NOT EXISTS "validated_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "hotel_bl_relationships_validation_idx"
  ON "hotel_bl_relationships" ("entity_scope", "url_validation_status");
