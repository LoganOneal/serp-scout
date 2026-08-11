ALTER TABLE "spend_ledger" ADD COLUMN "discovery_run_id" integer;--> statement-breakpoint
ALTER TABLE "serp_checks" ADD COLUMN "serp_pack_position" integer;--> statement-breakpoint
ALTER TABLE "serp_checks" ADD COLUMN "serp_source_kind" text;--> statement-breakpoint
CREATE TABLE "discovery_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"phase" text DEFAULT 'serp' NOT NULL,
	"budget_cap_micros" bigint NOT NULL,
	"spend_micros" bigint DEFAULT 0 NOT NULL,
	"used_fixtures" boolean DEFAULT true NOT NULL,
	"niche_count" integer DEFAULT 0 NOT NULL,
	"geo_count" integer DEFAULT 0 NOT NULL,
	"job_count" integer DEFAULT 0 NOT NULL,
	"jobs_done" integer DEFAULT 0 NOT NULL,
	"jobs_failed" integer DEFAULT 0 NOT NULL,
	"jobs_skipped" integer DEFAULT 0 NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"commentability_mode" text DEFAULT 'on_promote' NOT NULL,
	"label" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_niches" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"label" text NOT NULL,
	"slug" text,
	"niche_id" integer,
	"keyword_primary" text NOT NULL,
	"keyword_near_me" text NOT NULL,
	"near_me_synthesised" boolean DEFAULT false NOT NULL,
	"import_batch" text NOT NULL,
	"line_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_geos" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"raw_name" text NOT NULL,
	"raw_state" text,
	"raw_population" integer,
	"raw_kind" text,
	"locality_id" integer,
	"provider_location_code" integer,
	"location_source" text,
	"resolve_status" text NOT NULL,
	"unmatched_reason" text,
	"candidate_count" integer,
	"import_batch" text NOT NULL,
	"line_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"discovery_niche_id" integer,
	"discovery_geo_id" integer,
	"locality_id" integer,
	"kind" text DEFAULT 'serp' NOT NULL,
	"keyword" text,
	"keyword_variant" text,
	"discovery_hit_id" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"error" text,
	"measured_via" text,
	"reddit_hit_count" integer DEFAULT 0 NOT NULL,
	"raw_items" jsonb,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_hits" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"run_id" integer NOT NULL,
	"locality_id" integer,
	"discovery_niche_id" integer,
	"niche_id" integer,
	"keyword" text NOT NULL,
	"reddit_url" text NOT NULL,
	"reddit_post_id" text NOT NULL,
	"subreddit" text,
	"title" text,
	"source_kind" text NOT NULL,
	"organic_position" integer,
	"rank_absolute" integer,
	"pack_position" integer,
	"domain" text NOT NULL,
	"commentable" boolean,
	"commentable_detail" text,
	"commentable_checked_at" timestamp with time zone,
	"promoted_site_id" integer,
	"promoted_keyword_id" integer,
	"promoted_target_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_discovery_run_id_discovery_runs_id_fk" FOREIGN KEY ("discovery_run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_niches" ADD CONSTRAINT "discovery_niches_run_id_discovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_niches" ADD CONSTRAINT "discovery_niches_niche_id_niches_id_fk" FOREIGN KEY ("niche_id") REFERENCES "public"."niches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_geos" ADD CONSTRAINT "discovery_geos_run_id_discovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_geos" ADD CONSTRAINT "discovery_geos_locality_id_localities_id_fk" FOREIGN KEY ("locality_id") REFERENCES "public"."localities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_run_id_discovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_discovery_niche_id_discovery_niches_id_fk" FOREIGN KEY ("discovery_niche_id") REFERENCES "public"."discovery_niches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_discovery_geo_id_discovery_geos_id_fk" FOREIGN KEY ("discovery_geo_id") REFERENCES "public"."discovery_geos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_locality_id_localities_id_fk" FOREIGN KEY ("locality_id") REFERENCES "public"."localities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_jobs" ADD CONSTRAINT "discovery_jobs_discovery_hit_id_discovery_hits_id_fk" FOREIGN KEY ("discovery_hit_id") REFERENCES "public"."discovery_hits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_hits" ADD CONSTRAINT "discovery_hits_job_id_discovery_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."discovery_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_hits" ADD CONSTRAINT "discovery_hits_run_id_discovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_hits" ADD CONSTRAINT "discovery_hits_locality_id_localities_id_fk" FOREIGN KEY ("locality_id") REFERENCES "public"."localities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_hits" ADD CONSTRAINT "discovery_hits_discovery_niche_id_discovery_niches_id_fk" FOREIGN KEY ("discovery_niche_id") REFERENCES "public"."discovery_niches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_hits" ADD CONSTRAINT "discovery_hits_niche_id_niches_id_fk" FOREIGN KEY ("niche_id") REFERENCES "public"."niches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_hits" ADD CONSTRAINT "discovery_hits_promoted_site_id_sites_id_fk" FOREIGN KEY ("promoted_site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_hits" ADD CONSTRAINT "discovery_hits_promoted_keyword_id_serp_keywords_id_fk" FOREIGN KEY ("promoted_keyword_id") REFERENCES "public"."serp_keywords"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_hits" ADD CONSTRAINT "discovery_hits_promoted_target_id_serp_targets_id_fk" FOREIGN KEY ("promoted_target_id") REFERENCES "public"."serp_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spend_ledger_discovery_run_idx" ON "spend_ledger" USING btree ("discovery_run_id");--> statement-breakpoint
CREATE INDEX "discovery_runs_status_idx" ON "discovery_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "discovery_niches_run_idx" ON "discovery_niches" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_niches_run_keyword_uq" ON "discovery_niches" USING btree ("run_id","keyword_primary");--> statement-breakpoint
CREATE INDEX "discovery_geos_run_idx" ON "discovery_geos" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "discovery_geos_resolve_idx" ON "discovery_geos" USING btree ("run_id","resolve_status");--> statement-breakpoint
CREATE INDEX "discovery_jobs_claim_idx" ON "discovery_jobs" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "discovery_jobs_run_status_idx" ON "discovery_jobs" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_hits_job_post_source_uq" ON "discovery_hits" USING btree ("job_id","reddit_post_id","source_kind");--> statement-breakpoint
CREATE INDEX "discovery_hits_run_idx" ON "discovery_hits" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "discovery_hits_locality_niche_idx" ON "discovery_hits" USING btree ("locality_id","niche_id");
