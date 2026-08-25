-- Inventory-first Hotel Backlink Scout. This is intentionally separate from
-- hht_bl_* competitor research: its opportunity unit is hotel x linking entity.

CREATE TABLE IF NOT EXISTS "hotel_bl_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "source_filename" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "current_stage" text DEFAULT 'import' NOT NULL,
  "configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "external_api_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "hotel_bl_runs_status_idx" ON "hotel_bl_runs" ("status", "created_at");

CREATE TABLE IF NOT EXISTS "hotel_bl_hotels" (
  "id" serial PRIMARY KEY NOT NULL,
  "last_run_id" integer REFERENCES "hotel_bl_runs"("id") ON DELETE set null,
  "source_key" text NOT NULL,
  "hotel_name" text NOT NULL,
  "city" text,
  "state" text,
  "country" text,
  "existing_hht_url" text,
  "source_url" text,
  "source_link_type" text,
  "canonical_property_domain" text,
  "brand_name" text,
  "brand_control_segment" text,
  "site_control_type" text DEFAULT 'unknown' NOT NULL,
  "site_control_confidence" double precision DEFAULT 0 NOT NULL,
  "site_control_reason" text,
  "raw_source" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "needs_review" boolean DEFAULT false NOT NULL,
  "manual_site_control_type" text,
  "manual_brand_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hotel_bl_hotels_source_key_uq" ON "hotel_bl_hotels" ("source_key");
CREATE INDEX IF NOT EXISTS "hotel_bl_hotels_geo_idx" ON "hotel_bl_hotels" ("state", "city");
CREATE INDEX IF NOT EXISTS "hotel_bl_hotels_control_idx" ON "hotel_bl_hotels" ("site_control_type", "brand_control_segment");

CREATE TABLE IF NOT EXISTS "hotel_bl_domains" (
  "id" serial PRIMARY KEY NOT NULL,
  "last_run_id" integer REFERENCES "hotel_bl_runs"("id") ON DELETE set null,
  "domain" text NOT NULL,
  "root_domain" text NOT NULL,
  "canonical_url" text NOT NULL,
  "entity_name" text,
  "entity_type" text,
  "site_control_type" text DEFAULT 'unknown' NOT NULL,
  "site_control_confidence" double precision DEFAULT 0 NOT NULL,
  "site_control_reason" text,
  "hotel_count" integer DEFAULT 0 NOT NULL,
  "singleton_domain" boolean DEFAULT false NOT NULL,
  "centralized_brand" boolean DEFAULT false NOT NULL,
  "crawl_status" text DEFAULT 'pending' NOT NULL,
  "last_crawled_at" timestamp with time zone,
  "crawl_error" text,
  "has_press_page" boolean DEFAULT false NOT NULL,
  "has_awards_page" boolean DEFAULT false NOT NULL,
  "has_blog_or_news" boolean DEFAULT false NOT NULL,
  "has_external_press_links" boolean DEFAULT false NOT NULL,
  "external_press_link_count" integer DEFAULT 0 NOT NULL,
  "dofollow_external_press_link_count" integer DEFAULT 0 NOT NULL,
  "press_link_ratio" double precision,
  "latest_press_date" timestamp with time zone,
  "freshness_days" integer,
  "freshness_confidence" double precision,
  "has_named_pr_contact" boolean DEFAULT false NOT NULL,
  "has_pr_email" boolean DEFAULT false NOT NULL,
  "has_press_kit" boolean DEFAULT false NOT NULL,
  "authority_score" integer,
  "organic_traffic" integer,
  "referring_domains" integer,
  "already_links_to_hht" boolean,
  "backlink_value_score" double precision,
  "semrush_raw" jsonb,
  "semrush_measured_at" timestamp with time zone,
  "needs_review" boolean DEFAULT false NOT NULL,
  "manual_site_control_type" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hotel_bl_domains_domain_uq" ON "hotel_bl_domains" ("domain");
CREATE INDEX IF NOT EXISTS "hotel_bl_domains_root_idx" ON "hotel_bl_domains" ("root_domain");
CREATE INDEX IF NOT EXISTS "hotel_bl_domains_crawl_idx" ON "hotel_bl_domains" ("crawl_status", "site_control_type");

CREATE TABLE IF NOT EXISTS "hotel_bl_relationships" (
  "id" serial PRIMARY KEY NOT NULL,
  "hotel_id" integer NOT NULL REFERENCES "hotel_bl_hotels"("id") ON DELETE cascade,
  "domain_id" integer NOT NULL REFERENCES "hotel_bl_domains"("id") ON DELETE cascade,
  "relationship_type" text NOT NULL,
  "confidence" double precision DEFAULT 0 NOT NULL,
  "source" text NOT NULL,
  "source_url" text,
  "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "needs_review" boolean DEFAULT false NOT NULL,
  "manual_relationship_type" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hotel_bl_relationships_uq" ON "hotel_bl_relationships" ("hotel_id", "domain_id", "relationship_type");
CREATE INDEX IF NOT EXISTS "hotel_bl_relationships_domain_idx" ON "hotel_bl_relationships" ("domain_id", "relationship_type");

CREATE TABLE IF NOT EXISTS "hotel_bl_discovered_pages" (
  "id" serial PRIMARY KEY NOT NULL,
  "domain_id" integer NOT NULL REFERENCES "hotel_bl_domains"("id") ON DELETE cascade,
  "url" text NOT NULL,
  "page_type" text DEFAULT 'other' NOT NULL,
  "title" text,
  "status_code" integer,
  "last_modified_or_detected_date" timestamp with time zone,
  "external_link_count" integer DEFAULT 0 NOT NULL,
  "external_press_link_count" integer DEFAULT 0 NOT NULL,
  "dofollow_external_press_link_count" integer DEFAULT 0 NOT NULL,
  "last_content_date" timestamp with time zone,
  "date_confidence" double precision,
  "raw_html" text,
  "content_hash" text,
  "error" text,
  "crawl_timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hotel_bl_discovered_pages_uq" ON "hotel_bl_discovered_pages" ("domain_id", "url");
CREATE INDEX IF NOT EXISTS "hotel_bl_discovered_pages_type_idx" ON "hotel_bl_discovered_pages" ("domain_id", "page_type");

CREATE TABLE IF NOT EXISTS "hotel_bl_editorial_links" (
  "id" serial PRIMARY KEY NOT NULL,
  "page_id" integer NOT NULL REFERENCES "hotel_bl_discovered_pages"("id") ON DELETE cascade,
  "destination_url" text NOT NULL,
  "destination_domain" text NOT NULL,
  "anchor_text" text,
  "destination_url_hash" text GENERATED ALWAYS AS (md5("destination_url")) STORED,
  "anchor_text_hash" text GENERATED ALWAYS AS (md5("anchor_text")) STORED,
  "rel" text,
  "nofollow" boolean DEFAULT false NOT NULL,
  "sponsored" boolean DEFAULT false NOT NULL,
  "ugc" boolean DEFAULT false NOT NULL,
  "followed" boolean NOT NULL,
  "editorial" boolean DEFAULT true NOT NULL,
  "publication_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hotel_bl_editorial_links_uq" ON "hotel_bl_editorial_links" (
  "page_id",
  "destination_url_hash",
  "anchor_text_hash"
);
CREATE INDEX IF NOT EXISTS "hotel_bl_editorial_links_domain_idx" ON "hotel_bl_editorial_links" ("destination_domain", "followed");

CREATE TABLE IF NOT EXISTS "hotel_bl_contacts" (
  "id" serial PRIMARY KEY NOT NULL,
  "domain_id" integer NOT NULL REFERENCES "hotel_bl_domains"("id") ON DELETE cascade,
  "hotel_id" integer REFERENCES "hotel_bl_hotels"("id") ON DELETE cascade,
  "name" text,
  "title" text,
  "email" text,
  "phone" text,
  "contact_type" text DEFAULT 'general' NOT NULL,
  "source_url" text NOT NULL,
  "confidence" double precision DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hotel_bl_contacts_uq" ON "hotel_bl_contacts" ("domain_id", "source_url", "email", "phone");
CREATE INDEX IF NOT EXISTS "hotel_bl_contacts_type_idx" ON "hotel_bl_contacts" ("domain_id", "contact_type");

CREATE TABLE IF NOT EXISTS "hotel_bl_opportunities" (
  "id" serial PRIMARY KEY NOT NULL,
  "hotel_id" integer NOT NULL REFERENCES "hotel_bl_hotels"("id") ON DELETE cascade,
  "domain_id" integer NOT NULL REFERENCES "hotel_bl_domains"("id") ON DELETE cascade,
  "relationship_id" integer NOT NULL REFERENCES "hotel_bl_relationships"("id") ON DELETE cascade,
  "relationship_type" text NOT NULL,
  "feasibility_score" double precision DEFAULT 0 NOT NULL,
  "feasibility_components" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "link_value_score" double precision DEFAULT 0 NOT NULL,
  "link_value_components" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "content_fit_score" double precision DEFAULT 0 NOT NULL,
  "content_fit_components" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "effort_score" double precision DEFAULT 100 NOT NULL,
  "priority_score" double precision DEFAULT 0 NOT NULL,
  "recommended_content_type" text,
  "recommended_target_page" text,
  "recommended_pitch_angle" text,
  "reasoning_summary" text,
  "status" text DEFAULT 'new' NOT NULL,
  "needs_review" boolean DEFAULT false NOT NULL,
  "manual_recommended_content_type" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hotel_bl_opportunities_uq" ON "hotel_bl_opportunities" ("hotel_id", "domain_id", "relationship_type");
CREATE INDEX IF NOT EXISTS "hotel_bl_opportunities_priority_idx" ON "hotel_bl_opportunities" ("priority_score", "feasibility_score");
CREATE INDEX IF NOT EXISTS "hotel_bl_opportunities_status_idx" ON "hotel_bl_opportunities" ("status", "needs_review");

CREATE TABLE IF NOT EXISTS "hotel_bl_content_opportunities" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hotel_bl_runs"("id") ON DELETE cascade,
  "content_type" text NOT NULL,
  "topic" text NOT NULL,
  "geography" text,
  "hotel_count" integer NOT NULL,
  "high_feasibility_hotel_count" integer DEFAULT 0 NOT NULL,
  "strong_press_behavior_count" integer DEFAULT 0 NOT NULL,
  "aggregate_opportunity_value" double precision DEFAULT 0 NOT NULL,
  "new_referring_domains" integer DEFAULT 0 NOT NULL,
  "estimated_effort" double precision DEFAULT 0 NOT NULL,
  "content_roi_score" double precision DEFAULT 0 NOT NULL,
  "suggested_slug" text NOT NULL,
  "status" text DEFAULT 'new' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hotel_bl_content_opportunities_uq" ON "hotel_bl_content_opportunities" ("run_id", "suggested_slug");
CREATE INDEX IF NOT EXISTS "hotel_bl_content_opportunities_roi_idx" ON "hotel_bl_content_opportunities" ("run_id", "content_roi_score");

CREATE TABLE IF NOT EXISTS "hotel_bl_outcomes" (
  "id" serial PRIMARY KEY NOT NULL,
  "opportunity_id" integer NOT NULL REFERENCES "hotel_bl_opportunities"("id") ON DELETE cascade,
  "outreach_sent_at" timestamp with time zone,
  "contacted_email" text,
  "response" text,
  "positive_response" boolean,
  "backlink_acquired" boolean DEFAULT false NOT NULL,
  "backlink_url" text,
  "is_dofollow" boolean,
  "anchor_text" text,
  "acquired_at" timestamp with time zone,
  "notes" text,
  "feature_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hotel_bl_outcomes_opportunity_uq" ON "hotel_bl_outcomes" ("opportunity_id");

CREATE TABLE IF NOT EXISTS "hotel_bl_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hotel_bl_runs"("id") ON DELETE cascade,
  "domain_id" integer REFERENCES "hotel_bl_domains"("id") ON DELETE cascade,
  "stage" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "request_key" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "records_processed" integer DEFAULT 0 NOT NULL,
  "configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "claimed_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "hotel_bl_jobs_request_uq" ON "hotel_bl_jobs" ("run_id", "request_key");
CREATE INDEX IF NOT EXISTS "hotel_bl_jobs_status_idx" ON "hotel_bl_jobs" ("run_id", "status", "stage");

CREATE TABLE IF NOT EXISTS "hotel_bl_run_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hotel_bl_runs"("id") ON DELETE cascade,
  "job_id" integer REFERENCES "hotel_bl_jobs"("id") ON DELETE set null,
  "domain_id" integer REFERENCES "hotel_bl_domains"("id") ON DELETE set null,
  "stage" text NOT NULL,
  "level" text DEFAULT 'info' NOT NULL,
  "message" text NOT NULL,
  "details" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "hotel_bl_run_events_run_idx" ON "hotel_bl_run_events" ("run_id", "created_at");
