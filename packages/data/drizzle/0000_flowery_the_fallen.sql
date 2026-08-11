CREATE TABLE "calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"retell_call_id" text NOT NULL,
	"site_id" integer,
	"unattributed_reason" text,
	"direction" text DEFAULT 'inbound' NOT NULL,
	"from_number" text,
	"to_number" text,
	"agent_id" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"disconnection_reason" text,
	"ingest_state" text DEFAULT 'started' NOT NULL,
	"transcript" text,
	"transcript_object" jsonb,
	"analysis" jsonb,
	"user_sentiment" text,
	"call_successful" boolean,
	"in_voicemail" boolean,
	"latency_e2e_p50_ms" integer,
	"latency_e2e_p90_ms" integer,
	"latency_e2e_p95_ms" integer,
	"latency_llm_p50_ms" integer,
	"latency_tts_p50_ms" integer,
	"cost_micros" bigint,
	"recording_url_upstream" text,
	"recording_path" text,
	"recording_bytes" integer,
	"recording_fetched_at" timestamp with time zone,
	"recording_missing_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_authority" (
	"target" text PRIMARY KEY NOT NULL,
	"rank" integer,
	"referring_domains" integer,
	"referring_domains_nofollow" integer,
	"referring_main_domains" integer,
	"spam_score" integer,
	"sources" jsonb NOT NULL,
	"resolved" boolean NOT NULL,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_availability" (
	"domain" text PRIMARY KEY NOT NULL,
	"available" boolean,
	"method" text NOT NULL,
	"http_status" integer,
	"detail" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"channel" text NOT NULL,
	"target" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"provider_id" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer,
	"call_id" integer,
	"source" text DEFAULT 'call' NOT NULL,
	"name" text,
	"phone" text,
	"email" text,
	"address_line" text,
	"city" text,
	"zip" text,
	"problem" text,
	"system_type" text,
	"system_age_years" integer,
	"is_emergency" boolean,
	"hazard" text,
	"in_service_area" boolean,
	"is_owner" boolean,
	"is_commercial" boolean,
	"qualified" boolean,
	"captured_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"captured_via" text DEFAULT 'tool' NOT NULL,
	"reconcile_conflict" jsonb,
	"appointment_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "localities" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"raw_name" text NOT NULL,
	"state_code" text NOT NULL,
	"state_name" text NOT NULL,
	"fips" text NOT NULL,
	"county_fips" text,
	"county_name" text,
	"population" integer,
	"lat" double precision,
	"lon" double precision,
	"land_area_sq_mi" double precision,
	"provider_location_code" integer,
	"provider_location_name" text,
	"resolution_method" text,
	"location_source" text,
	"unmatched_reason" text,
	"search_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "niches" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"keyword_noun" text NOT NULL,
	"emd_token" text NOT NULL,
	"domain_stems" jsonb NOT NULL,
	"category" text NOT NULL,
	"demand_per_capita_per_1k" double precision NOT NULL,
	"value_per_search_micros" bigint NOT NULL,
	"rent_floor_micros" bigint NOT NULL,
	"rent_ceiling_micros" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcomes" (
	"id" serial PRIMARY KEY NOT NULL,
	"shortlist_item_id" integer NOT NULL,
	"day_offset" integer NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"position" integer,
	"keyword" text NOT NULL,
	"location_code" integer NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"locality_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"budget_cap_micros" bigint NOT NULL,
	"spend_micros" bigint DEFAULT 0 NOT NULL,
	"niche_count" integer,
	"used_fixtures" boolean DEFAULT true NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"scan_run_id" integer NOT NULL,
	"locality_id" integer NOT NULL,
	"niche_id" integer NOT NULL,
	"keyword" text NOT NULL,
	"difficulty" integer,
	"weight_covered" double precision NOT NULL,
	"components" jsonb NOT NULL,
	"verdict" text NOT NULL,
	"blockers" jsonb NOT NULL,
	"gates" jsonb NOT NULL,
	"volume_est" integer,
	"volume_estimated" boolean DEFAULT true NOT NULL,
	"rent_micros" bigint,
	"slots_open" integer NOT NULL,
	"platform_held_slots" integer NOT NULL,
	"median_ref_domains" double precision,
	"link_data_measured" boolean NOT NULL,
	"emd_domain" text NOT NULL,
	"emd_available" boolean,
	"emd_availability_method" text,
	"emd_availability_detail" text,
	"results" jsonb NOT NULL,
	"map_pack" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "serp_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"keyword" text NOT NULL,
	"location_code" integer NOT NULL,
	"se_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shortlist_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"locality_id" integer NOT NULL,
	"niche_id" integer NOT NULL,
	"scan_target_id" integer,
	"difficulty_at_save" integer,
	"verdict_at_save" text NOT NULL,
	"weight_covered_at_save" double precision NOT NULL,
	"emd_available_at_save" boolean,
	"emd_domain" text NOT NULL,
	"state" text DEFAULT 'watching' NOT NULL,
	"build_started_at" timestamp with time zone,
	"notes" text,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" serial PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"locality_id" integer NOT NULL,
	"niche_id" integer NOT NULL,
	"shortlist_item_id" integer,
	"status" text DEFAULT 'parked' NOT NULL,
	"display_name" text,
	"tracking_number" text,
	"twilio_number_sid" text,
	"retell_number_imported_at" timestamp with time zone,
	"retell_agent_id" text,
	"retell_agent_version" integer,
	"prompt_fingerprint" text,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"hours" jsonb,
	"service_area_zips" jsonb,
	"dispatch_fee_micros" bigint,
	"on_call_number" text,
	"lead_alert_number" text,
	"first_webhook_at" timestamp with time zone,
	"last_webhook_at" timestamp with time zone,
	"purchased_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"scan_run_id" integer,
	"site_id" integer,
	"endpoint" text NOT NULL,
	"cost_micros" bigint NOT NULL,
	"rows" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"call_id" integer,
	"lead_id" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'retell' NOT NULL,
	"event_type" text NOT NULL,
	"retell_call_id" text,
	"site_id" integer,
	"payload" jsonb NOT NULL,
	"signature_valid" boolean NOT NULL,
	"handler_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_deliveries" ADD CONSTRAINT "lead_deliveries_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_shortlist_item_id_shortlist_items_id_fk" FOREIGN KEY ("shortlist_item_id") REFERENCES "public"."shortlist_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_locality_id_localities_id_fk" FOREIGN KEY ("locality_id") REFERENCES "public"."localities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_targets" ADD CONSTRAINT "scan_targets_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_targets" ADD CONSTRAINT "scan_targets_locality_id_localities_id_fk" FOREIGN KEY ("locality_id") REFERENCES "public"."localities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_targets" ADD CONSTRAINT "scan_targets_niche_id_niches_id_fk" FOREIGN KEY ("niche_id") REFERENCES "public"."niches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlist_items" ADD CONSTRAINT "shortlist_items_locality_id_localities_id_fk" FOREIGN KEY ("locality_id") REFERENCES "public"."localities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlist_items" ADD CONSTRAINT "shortlist_items_niche_id_niches_id_fk" FOREIGN KEY ("niche_id") REFERENCES "public"."niches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlist_items" ADD CONSTRAINT "shortlist_items_scan_target_id_scan_targets_id_fk" FOREIGN KEY ("scan_target_id") REFERENCES "public"."scan_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_locality_id_localities_id_fk" FOREIGN KEY ("locality_id") REFERENCES "public"."localities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_niche_id_niches_id_fk" FOREIGN KEY ("niche_id") REFERENCES "public"."niches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_shortlist_item_id_shortlist_items_id_fk" FOREIGN KEY ("shortlist_item_id") REFERENCES "public"."shortlist_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_jobs" ADD CONSTRAINT "voice_jobs_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_jobs" ADD CONSTRAINT "voice_jobs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calls_retell_call_id_uq" ON "calls" USING btree ("retell_call_id");--> statement-breakpoint
CREATE INDEX "calls_site_time_idx" ON "calls" USING btree ("site_id","started_at");--> statement-breakpoint
CREATE INDEX "calls_created_idx" ON "calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "domain_authority_expiry_idx" ON "domain_authority" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "domain_availability_expiry_idx" ON "domain_availability" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "lead_deliveries_lead_idx" ON "lead_deliveries" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "lead_deliveries_status_idx" ON "lead_deliveries" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_call_uq" ON "leads" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "leads_site_time_idx" ON "leads" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_emergency_idx" ON "leads" USING btree ("is_emergency");--> statement-breakpoint
CREATE UNIQUE INDEX "localities_slug_uq" ON "localities" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "localities_kind_fips_uq" ON "localities" USING btree ("kind","fips");--> statement-breakpoint
CREATE INDEX "localities_search_idx" ON "localities" USING btree ("search_text");--> statement-breakpoint
CREATE INDEX "localities_population_idx" ON "localities" USING btree ("population");--> statement-breakpoint
CREATE INDEX "localities_resolved_idx" ON "localities" USING btree ("provider_location_code");--> statement-breakpoint
CREATE UNIQUE INDEX "niches_slug_uq" ON "niches" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "niches_active_idx" ON "niches" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "outcomes_item_day_uq" ON "outcomes" USING btree ("shortlist_item_id","day_offset");--> statement-breakpoint
CREATE INDEX "scan_runs_claim_idx" ON "scan_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "scan_runs_locality_idx" ON "scan_runs" USING btree ("locality_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scan_targets_run_niche_uq" ON "scan_targets" USING btree ("scan_run_id","niche_id");--> statement-breakpoint
CREATE INDEX "scan_targets_run_idx" ON "scan_targets" USING btree ("scan_run_id","difficulty");--> statement-breakpoint
CREATE UNIQUE INDEX "serp_snapshots_key_uq" ON "serp_snapshots" USING btree ("keyword","location_code","se_type");--> statement-breakpoint
CREATE INDEX "serp_snapshots_expiry_idx" ON "serp_snapshots" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shortlist_items_cell_uq" ON "shortlist_items" USING btree ("locality_id","niche_id");--> statement-breakpoint
CREATE INDEX "shortlist_items_state_idx" ON "shortlist_items" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_domain_uq" ON "sites" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "sites_tracking_idx" ON "sites" USING btree ("tracking_number");--> statement-breakpoint
CREATE INDEX "sites_cell_idx" ON "sites" USING btree ("locality_id","niche_id");--> statement-breakpoint
CREATE INDEX "sites_status_idx" ON "sites" USING btree ("status");--> statement-breakpoint
CREATE INDEX "spend_ledger_run_idx" ON "spend_ledger" USING btree ("scan_run_id");--> statement-breakpoint
CREATE INDEX "spend_ledger_site_idx" ON "spend_ledger" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "voice_jobs_claim_idx" ON "voice_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_jobs_kind_call_uq" ON "voice_jobs" USING btree ("kind","call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_dedupe_uq" ON "webhook_events" USING btree ("event_type","retell_call_id");--> statement-breakpoint
CREATE INDEX "webhook_events_call_idx" ON "webhook_events" USING btree ("retell_call_id");--> statement-breakpoint
CREATE INDEX "webhook_events_received_idx" ON "webhook_events" USING btree ("received_at");