ALTER TABLE "discovery_runs" ADD COLUMN "source" text DEFAULT 'legacy_csv' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "devices" text DEFAULT 'desktop' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "include_near_me" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "geo_tier_filter" text;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "estimated_cost_micros" bigint;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "selection_note" text;--> statement-breakpoint
CREATE TABLE "research_keyword_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_filename" text NOT NULL,
	"source_kind" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"date_range_raw" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_keywords" (
	"id" serial PRIMARY KEY NOT NULL,
	"import_id" integer NOT NULL,
	"keyword" text NOT NULL,
	"keyword_norm" text NOT NULL,
	"seed_key" text NOT NULL,
	"variant" text DEFAULT 'primary' NOT NULL,
	"avg_monthly_searches" double precision,
	"competition" text,
	"competition_index" double precision,
	"top_of_page_bid_low_micros" bigint,
	"top_of_page_bid_high_micros" bigint,
	"top_of_page_bid_raw" text,
	"in_account" text,
	"monthly_series" jsonb,
	"niche_id" integer,
	"active" boolean DEFAULT true NOT NULL,
	"line_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_geo_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_filename" text NOT NULL,
	"source_kind" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_geos" (
	"id" serial PRIMARY KEY NOT NULL,
	"import_id" integer NOT NULL,
	"market" text NOT NULL,
	"state" text,
	"state_abbr" text,
	"population_2025" integer,
	"selected_rank" integer,
	"test_tier" text,
	"dataforseo_location_code" integer,
	"dataforseo_location_name" text,
	"dataforseo_location_type" text,
	"natural_query_modifier" text,
	"disambiguated_query_modifier" text,
	"recommended_explicit_modifier" text,
	"extra" jsonb,
	"locality_id" integer,
	"location_source" text,
	"resolve_status" text NOT NULL,
	"unmatched_reason" text,
	"active" boolean DEFAULT true NOT NULL,
	"line_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD COLUMN "device" text DEFAULT 'desktop' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD COLUMN "os" text DEFAULT 'windows' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD COLUMN "depth" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD COLUMN "research_keyword_id" integer;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD COLUMN "research_geo_id" integer;--> statement-breakpoint
CREATE TABLE "discovery_serp_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"run_id" integer NOT NULL,
	"locality_id" integer,
	"niche_id" integer,
	"research_keyword_id" integer,
	"research_geo_id" integer,
	"keyword" text NOT NULL,
	"keyword_variant" text,
	"device" text NOT NULL,
	"os" text NOT NULL,
	"location_code" integer NOT NULL,
	"first_organic_rank_absolute" integer,
	"ads_above_organic_count" integer DEFAULT 0 NOT NULL,
	"local_profiles_above_organic_count" integer DEFAULT 0 NOT NULL,
	"organic_count" integer DEFAULT 0 NOT NULL,
	"paid_count" integer DEFAULT 0 NOT NULL,
	"local_pack_count" integer DEFAULT 0 NOT NULL,
	"discussions_pack_present" boolean DEFAULT false NOT NULL,
	"reddit_hit_count" integer DEFAULT 0 NOT NULL,
	"related_searches" jsonb,
	"item_types" jsonb,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research_keywords" ADD CONSTRAINT "research_keywords_import_id_research_keyword_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."research_keyword_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_keywords" ADD CONSTRAINT "research_keywords_niche_id_niches_id_fk" FOREIGN KEY ("niche_id") REFERENCES "public"."niches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_geos" ADD CONSTRAINT "research_geos_import_id_research_geo_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."research_geo_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_geos" ADD CONSTRAINT "research_geos_locality_id_localities_id_fk" FOREIGN KEY ("locality_id") REFERENCES "public"."localities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_research_keyword_id_research_keywords_id_fk" FOREIGN KEY ("research_keyword_id") REFERENCES "public"."research_keywords"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_research_geo_id_research_geos_id_fk" FOREIGN KEY ("research_geo_id") REFERENCES "public"."research_geos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_serp_metrics" ADD CONSTRAINT "discovery_serp_metrics_job_id_discovery_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."discovery_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_serp_metrics" ADD CONSTRAINT "discovery_serp_metrics_run_id_discovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_serp_metrics" ADD CONSTRAINT "discovery_serp_metrics_locality_id_localities_id_fk" FOREIGN KEY ("locality_id") REFERENCES "public"."localities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_serp_metrics" ADD CONSTRAINT "discovery_serp_metrics_niche_id_niches_id_fk" FOREIGN KEY ("niche_id") REFERENCES "public"."niches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_serp_metrics" ADD CONSTRAINT "discovery_serp_metrics_research_keyword_id_research_keywords_id_fk" FOREIGN KEY ("research_keyword_id") REFERENCES "public"."research_keywords"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_serp_metrics" ADD CONSTRAINT "discovery_serp_metrics_research_geo_id_research_geos_id_fk" FOREIGN KEY ("research_geo_id") REFERENCES "public"."research_geos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "research_keywords_norm_uq" ON "research_keywords" USING btree ("keyword_norm");--> statement-breakpoint
CREATE INDEX "research_keywords_active_vol_idx" ON "research_keywords" USING btree ("active","avg_monthly_searches");--> statement-breakpoint
CREATE INDEX "research_geos_code_idx" ON "research_geos" USING btree ("dataforseo_location_code");--> statement-breakpoint
CREATE INDEX "research_geos_rank_idx" ON "research_geos" USING btree ("active","selected_rank");--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_serp_metrics_job_uq" ON "discovery_serp_metrics" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "discovery_serp_metrics_cell_device_idx" ON "discovery_serp_metrics" USING btree ("locality_id","niche_id","device","measured_at");--> statement-breakpoint
CREATE INDEX "discovery_serp_metrics_catalog_idx" ON "discovery_serp_metrics" USING btree ("research_keyword_id","research_geo_id","device");
