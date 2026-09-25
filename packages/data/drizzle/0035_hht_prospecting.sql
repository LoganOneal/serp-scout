-- Hotel Hot Tubs SERP backlink prospecting. Keyword volume is a prioritization
-- feature; the output is editorial pages that could logically link to HHT.

CREATE TABLE IF NOT EXISTS "hht_px_geographies" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "query_name" text NOT NULL,
  "normalized_name" text NOT NULL,
  "state" text,
  "state_code" text,
  "type" text NOT NULL,
  "parent_geo_id" integer,
  "hht_slug" text,
  "hotel_count" integer,
  "private_hot_tub_count" integer,
  "shared_hot_tub_count" integer,
  "editors_choice_count" integer,
  "active" boolean DEFAULT true NOT NULL,
  "priority" integer DEFAULT 50 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "hht_px_geographies" ADD CONSTRAINT "hht_px_geographies_parent_geo_id_fkey" FOREIGN KEY ("parent_geo_id") REFERENCES "hht_px_geographies"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "hht_px_geographies_type_name_state_uq" ON "hht_px_geographies" ("type", "normalized_name", "state_code");
CREATE INDEX IF NOT EXISTS "hht_px_geographies_active_idx" ON "hht_px_geographies" ("active", "priority", "type");

CREATE TABLE IF NOT EXISTS "hht_px_keyword_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "template" text NOT NULL,
  "cluster" text NOT NULL,
  "variant_group" text NOT NULL,
  "priority" text NOT NULL,
  "expected_linkability" text NOT NULL,
  "geographic" boolean DEFAULT true NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_px_keyword_templates_template_uq" ON "hht_px_keyword_templates" ("template");
CREATE INDEX IF NOT EXISTS "hht_px_keyword_templates_cluster_idx" ON "hht_px_keyword_templates" ("cluster", "variant_group");

CREATE TABLE IF NOT EXISTS "hht_px_keywords" (
  "id" serial PRIMARY KEY NOT NULL,
  "geography_id" integer,
  "template_id" integer,
  "keyword" text NOT NULL,
  "keyword_norm" text NOT NULL,
  "cluster" text NOT NULL,
  "variant_group" text NOT NULL,
  "source" text DEFAULT 'template' NOT NULL,
  "priority" text NOT NULL,
  "expected_linkability" text NOT NULL,
  "is_representative" boolean DEFAULT false NOT NULL,
  "serp_equivalent" boolean DEFAULT false NOT NULL,
  "serp_status" text DEFAULT 'unchecked' NOT NULL,
  "promoted" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "hht_px_keywords" ADD CONSTRAINT "hht_px_keywords_geography_id_fkey" FOREIGN KEY ("geography_id") REFERENCES "hht_px_geographies"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "hht_px_keywords" ADD CONSTRAINT "hht_px_keywords_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "hht_px_keyword_templates"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "hht_px_keywords_norm_uq" ON "hht_px_keywords" ("keyword_norm", "geography_id");
CREATE UNIQUE INDEX IF NOT EXISTS "hht_px_keywords_national_norm_uq" ON "hht_px_keywords" ("keyword_norm") WHERE "geography_id" IS NULL;
CREATE INDEX IF NOT EXISTS "hht_px_keywords_variant_idx" ON "hht_px_keywords" ("geography_id", "variant_group", "is_representative");
CREATE INDEX IF NOT EXISTS "hht_px_keywords_cluster_idx" ON "hht_px_keywords" ("cluster", "serp_status");
CREATE INDEX IF NOT EXISTS "hht_px_keywords_source_idx" ON "hht_px_keywords" ("source", "promoted");

CREATE TABLE IF NOT EXISTS "hht_px_keyword_volumes" (
  "id" serial PRIMARY KEY NOT NULL,
  "keyword_id" integer NOT NULL,
  "requested_keyword" text NOT NULL,
  "returned_keyword" text,
  "close_variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "national_destination_volume" integer,
  "local_searcher_volume" integer,
  "monthly_searches" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "competition" text,
  "competition_index" integer,
  "low_bid_micros" bigint,
  "high_bid_micros" bigint,
  "google_ads_geo_target" integer DEFAULT 2840 NOT NULL,
  "google_ads_geo_label" text,
  "retrieved_at" timestamp with time zone,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "hht_px_keyword_volumes" ADD CONSTRAINT "hht_px_keyword_volumes_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "hht_px_keywords"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "hht_px_keyword_volumes_keyword_uq" ON "hht_px_keyword_volumes" ("keyword_id");

CREATE TABLE IF NOT EXISTS "hht_px_pipeline_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "current_stage" text DEFAULT 'geographies' NOT NULL,
  "configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "hht_px_pipeline_runs_status_idx" ON "hht_px_pipeline_runs" ("status", "created_at");

CREATE TABLE IF NOT EXISTS "hht_px_pipeline_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL,
  "stage" text NOT NULL,
  "provider" text NOT NULL,
  "target" text,
  "parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "request_key" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "records_completed" integer DEFAULT 0 NOT NULL,
  "estimated_units" double precision,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
DO $$ BEGIN
  ALTER TABLE "hht_px_pipeline_jobs" ADD CONSTRAINT "hht_px_pipeline_jobs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "hht_px_pipeline_runs"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "hht_px_pipeline_jobs_request_uq" ON "hht_px_pipeline_jobs" ("run_id", "request_key");
CREATE INDEX IF NOT EXISTS "hht_px_pipeline_jobs_status_idx" ON "hht_px_pipeline_jobs" ("run_id", "status", "stage");

CREATE TABLE IF NOT EXISTS "hht_px_serp_snapshots" (
  "id" serial PRIMARY KEY NOT NULL,
  "keyword_id" integer NOT NULL,
  "job_id" integer,
  "database_name" text DEFAULT 'us' NOT NULL,
  "editorial_density" double precision,
  "prospectable_density" double precision,
  "competitor_count" integer DEFAULT 0 NOT NULL,
  "unique_prospect_domains" integer DEFAULT 0 NOT NULL,
  "keyword_opportunity_score" double precision,
  "serp_features" text,
  "result_count" integer DEFAULT 0 NOT NULL,
  "retrieved_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "hht_px_serp_snapshots" ADD CONSTRAINT "hht_px_serp_snapshots_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "hht_px_keywords"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "hht_px_serp_snapshots" ADD CONSTRAINT "hht_px_serp_snapshots_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "hht_px_pipeline_jobs"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "hht_px_serp_snapshots_keyword_db_uq" ON "hht_px_serp_snapshots" ("keyword_id", "database_name");

CREATE TABLE IF NOT EXISTS "hht_px_serp_results" (
  "id" serial PRIMARY KEY NOT NULL,
  "snapshot_id" integer NOT NULL,
  "position" integer NOT NULL,
  "url" text NOT NULL,
  "normalized_url" text NOT NULL,
  "root_domain" text NOT NULL,
  "subdomain" text,
  "title" text,
  "snippet" text,
  "serp_features" text,
  "page_type" text NOT NULL,
  "is_prospectable" boolean DEFAULT false NOT NULL,
  "competitor_strength" text DEFAULT 'none' NOT NULL,
  "excluded_by_rule" boolean DEFAULT false NOT NULL,
  "classification_reason" text,
  "manual_override" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "hht_px_serp_results" ADD CONSTRAINT "hht_px_serp_results_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "hht_px_serp_snapshots"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "hht_px_serp_results_uq" ON "hht_px_serp_results" ("snapshot_id", "position", "normalized_url");
CREATE INDEX IF NOT EXISTS "hht_px_serp_results_domain_idx" ON "hht_px_serp_results" ("root_domain", "is_prospectable");

CREATE TABLE IF NOT EXISTS "hht_px_prospect_domains" (
  "id" serial PRIMARY KEY NOT NULL,
  "root_domain" text NOT NULL,
  "domain_type" text,
  "competitor_strength" text DEFAULT 'none' NOT NULL,
  "is_prospectable" boolean DEFAULT false NOT NULL,
  "page_count" integer DEFAULT 0 NOT NULL,
  "keyword_count" integer DEFAULT 0 NOT NULL,
  "geography_count" integer DEFAULT 0 NOT NULL,
  "cluster_count" integer DEFAULT 0 NOT NULL,
  "strongest_page_id" integer,
  "best_position" integer,
  "max_keyword_volume" integer,
  "authority_score" integer,
  "referring_domains" integer,
  "backlinks" integer,
  "organic_traffic" integer,
  "ranking_keywords" integer,
  "opportunity_score" double precision,
  "outreach_status" text DEFAULT 'not_contacted' NOT NULL,
  "notes" text,
  "enriched_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_px_prospect_domains_root_uq" ON "hht_px_prospect_domains" ("root_domain");
CREATE INDEX IF NOT EXISTS "hht_px_prospect_domains_score_idx" ON "hht_px_prospect_domains" ("opportunity_score");

CREATE TABLE IF NOT EXISTS "hht_px_prospect_pages" (
  "id" serial PRIMARY KEY NOT NULL,
  "domain_id" integer NOT NULL,
  "url" text NOT NULL,
  "normalized_url" text NOT NULL,
  "title" text,
  "page_type" text NOT NULL,
  "is_prospectable" boolean DEFAULT false NOT NULL,
  "competitor_strength" text DEFAULT 'none' NOT NULL,
  "matched_keyword_count" integer DEFAULT 0 NOT NULL,
  "max_keyword_volume" integer,
  "best_position" integer,
  "avg_position" double precision,
  "estimated_nondup_demand" integer,
  "topical_fit" integer,
  "link_fit" double precision,
  "opportunity_score" double precision,
  "suggested_hht_url" text,
  "why_link_category" text,
  "why_link" text,
  "outreach_status" text DEFAULT 'not_contacted' NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "hht_px_prospect_pages" ADD CONSTRAINT "hht_px_prospect_pages_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "hht_px_prospect_domains"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "hht_px_prospect_pages_url_uq" ON "hht_px_prospect_pages" ("normalized_url");
CREATE INDEX IF NOT EXISTS "hht_px_prospect_pages_score_idx" ON "hht_px_prospect_pages" ("opportunity_score");
CREATE INDEX IF NOT EXISTS "hht_px_prospect_pages_domain_idx" ON "hht_px_prospect_pages" ("domain_id", "is_prospectable");

CREATE TABLE IF NOT EXISTS "hht_px_page_keyword_matches" (
  "id" serial PRIMARY KEY NOT NULL,
  "page_id" integer NOT NULL,
  "keyword_id" integer NOT NULL,
  "snapshot_id" integer,
  "position" integer NOT NULL,
  "volume" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "hht_px_page_keyword_matches" ADD CONSTRAINT "hht_px_page_keyword_matches_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "hht_px_prospect_pages"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "hht_px_page_keyword_matches" ADD CONSTRAINT "hht_px_page_keyword_matches_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "hht_px_keywords"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "hht_px_page_keyword_matches" ADD CONSTRAINT "hht_px_page_keyword_matches_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "hht_px_serp_snapshots"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "hht_px_page_keyword_matches_uq" ON "hht_px_page_keyword_matches" ("page_id", "keyword_id");
CREATE INDEX IF NOT EXISTS "hht_px_page_keyword_matches_keyword_idx" ON "hht_px_page_keyword_matches" ("keyword_id", "position");

CREATE TABLE IF NOT EXISTS "hht_px_cluster_yields" (
  "id" serial PRIMARY KEY NOT NULL,
  "cluster" text NOT NULL,
  "serp_count" integer DEFAULT 0 NOT NULL,
  "prospectable_pages" integer DEFAULT 0 NOT NULL,
  "avg_editorial_density" double precision,
  "avg_prospectable_density" double precision,
  "avg_prospects_per_serp" double precision,
  "quality_adjusted_per_serp" double precision,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_px_cluster_yields_cluster_uq" ON "hht_px_cluster_yields" ("cluster");

CREATE TABLE IF NOT EXISTS "hht_px_domain_overrides" (
  "id" serial PRIMARY KEY NOT NULL,
  "root_domain" text NOT NULL,
  "page_type" text,
  "is_prospectable" boolean,
  "competitor_strength" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_px_domain_overrides_root_uq" ON "hht_px_domain_overrides" ("root_domain");
