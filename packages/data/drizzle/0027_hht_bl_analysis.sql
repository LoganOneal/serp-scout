-- HotelHotTubs backlink research V0.
-- Semrush credentials remain in Codex; these tables persist checkpoints, raw MCP
-- responses, derived research evidence, and the future acquired-link read model.

CREATE TABLE IF NOT EXISTS "hht_bl_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "profile" text DEFAULT 'pilot' NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "current_stage" text DEFAULT 'keywords' NOT NULL,
  "configuration" jsonb NOT NULL,
  "progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "waiting_reason" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "hht_bl_runs_site_status_idx" ON "hht_bl_runs" ("site_id", "status", "created_at");

CREATE TABLE IF NOT EXISTS "hht_bl_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hht_bl_runs"("id") ON DELETE cascade,
  "stage" text NOT NULL,
  "provider" text DEFAULT 'semrush_mcp' NOT NULL,
  "report_type" text NOT NULL,
  "target" text,
  "parameters" jsonb NOT NULL,
  "request_key" text NOT NULL,
  "offset" integer DEFAULT 0 NOT NULL,
  "limit" integer DEFAULT 50 NOT NULL,
  "records_completed" integer DEFAULT 0 NOT NULL,
  "rows_requested" integer DEFAULT 0 NOT NULL,
  "rows_received" integer DEFAULT 0 NOT NULL,
  "estimated_units_consumed" double precision,
  "account_identifier" text,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_success_at" timestamp with time zone,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_jobs_request_uq" ON "hht_bl_jobs" ("run_id", "request_key");
CREATE INDEX IF NOT EXISTS "hht_bl_jobs_status_idx" ON "hht_bl_jobs" ("run_id", "status", "stage");

CREATE TABLE IF NOT EXISTS "hht_bl_raw_responses" (
  "id" serial PRIMARY KEY NOT NULL,
  "job_id" integer REFERENCES "hht_bl_jobs"("id") ON DELETE set null,
  "run_id" integer NOT NULL REFERENCES "hht_bl_runs"("id") ON DELETE cascade,
  "provider" text NOT NULL,
  "report_type" text NOT NULL,
  "request_key" text NOT NULL,
  "parameters" jsonb NOT NULL,
  "raw_text" text NOT NULL,
  "payload_hash" text NOT NULL,
  "rows_received" integer NOT NULL,
  "estimated_units_consumed" double precision,
  "account_identifier" text,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_raw_responses_payload_uq" ON "hht_bl_raw_responses" ("run_id", "request_key", "payload_hash");
CREATE INDEX IF NOT EXISTS "hht_bl_raw_responses_report_idx" ON "hht_bl_raw_responses" ("run_id", "report_type", "fetched_at");

CREATE TABLE IF NOT EXISTS "hht_bl_keywords" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hht_bl_runs"("id") ON DELETE cascade,
  "category" text NOT NULL,
  "destination" text NOT NULL,
  "keyword" text NOT NULL,
  "search_volume" integer,
  "selected" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_keywords_run_keyword_uq" ON "hht_bl_keywords" ("run_id", "keyword");
CREATE INDEX IF NOT EXISTS "hht_bl_keywords_category_idx" ON "hht_bl_keywords" ("run_id", "category", "destination");

CREATE TABLE IF NOT EXISTS "hht_bl_serp_results" (
  "id" serial PRIMARY KEY NOT NULL,
  "keyword_id" integer NOT NULL REFERENCES "hht_bl_keywords"("id") ON DELETE cascade,
  "raw_response_id" integer REFERENCES "hht_bl_raw_responses"("id") ON DELETE set null,
  "position" integer NOT NULL,
  "domain" text NOT NULL,
  "url" text NOT NULL,
  "title" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_serp_results_uq" ON "hht_bl_serp_results" ("keyword_id", "position", "url");
CREATE INDEX IF NOT EXISTS "hht_bl_serp_results_domain_idx" ON "hht_bl_serp_results" ("domain", "position");

CREATE TABLE IF NOT EXISTS "hht_bl_candidate_sites" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hht_bl_runs"("id") ON DELETE cascade,
  "domain" text NOT NULL,
  "state" text DEFAULT 'DISCOVERED' NOT NULL,
  "provenance" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "seed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "discovery_depth" integer DEFAULT 0 NOT NULL,
  "serp_appearances" integer DEFAULT 0 NOT NULL,
  "top_3_appearances" integer DEFAULT 0 NOT NULL,
  "top_5_appearances" integer DEFAULT 0 NOT NULL,
  "top_10_appearances" integer DEFAULT 0 NOT NULL,
  "unique_keyword_categories" integer DEFAULT 0 NOT NULL,
  "unique_destinations" integer DEFAULT 0 NOT NULL,
  "weighted_visibility" double precision DEFAULT 0 NOT NULL,
  "weighted_search_volume_visibility" double precision,
  "research_value_score" double precision,
  "research_value_components" jsonb,
  "research_value_penalties" jsonb,
  "research_value_missing" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_candidate_sites_run_domain_uq" ON "hht_bl_candidate_sites" ("run_id", "domain");
CREATE INDEX IF NOT EXISTS "hht_bl_candidate_sites_score_idx" ON "hht_bl_candidate_sites" ("run_id", "research_value_score");

CREATE TABLE IF NOT EXISTS "hht_bl_site_classifications" (
  "id" serial PRIMARY KEY NOT NULL,
  "candidate_site_id" integer NOT NULL REFERENCES "hht_bl_candidate_sites"("id") ON DELETE cascade,
  "site_type" text NOT NULL,
  "business_model" text,
  "content_model" text,
  "affiliate_likely" boolean,
  "directory_likely" boolean,
  "programmatic_seo_likely" boolean,
  "hotel_inventory" boolean,
  "editorial_content" boolean,
  "geographic_landing_pages" boolean,
  "brand_dependency" integer,
  "travel_relevance" integer,
  "hht_similarity" integer,
  "transferability" integer,
  "reasoning" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "model" text,
  "classified_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_site_classifications_candidate_uq" ON "hht_bl_site_classifications" ("candidate_site_id");
CREATE INDEX IF NOT EXISTS "hht_bl_site_classifications_type_idx" ON "hht_bl_site_classifications" ("site_type");

CREATE TABLE IF NOT EXISTS "hht_bl_site_metrics" (
  "id" serial PRIMARY KEY NOT NULL,
  "candidate_site_id" integer NOT NULL REFERENCES "hht_bl_candidate_sites"("id") ON DELETE cascade,
  "raw_response_id" integer REFERENCES "hht_bl_raw_responses"("id") ON DELETE set null,
  "authority_score" integer,
  "organic_keywords" integer,
  "estimated_organic_traffic" integer,
  "estimated_traffic_value" double precision,
  "total_backlinks" integer,
  "referring_domains" integer,
  "follow_backlinks" integer,
  "nofollow_backlinks" integer,
  "measured_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_site_metrics_candidate_uq" ON "hht_bl_site_metrics" ("candidate_site_id");

CREATE TABLE IF NOT EXISTS "hht_bl_research_sites" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hht_bl_runs"("id") ON DELETE cascade,
  "candidate_site_id" integer NOT NULL REFERENCES "hht_bl_candidate_sites"("id") ON DELETE cascade,
  "cohort" text NOT NULL,
  "rank" integer NOT NULL,
  "selected_reason" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "selected_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_research_sites_candidate_uq" ON "hht_bl_research_sites" ("candidate_site_id");
CREATE INDEX IF NOT EXISTS "hht_bl_research_sites_rank_idx" ON "hht_bl_research_sites" ("run_id", "rank");

CREATE TABLE IF NOT EXISTS "hht_bl_referring_domains" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hht_bl_runs"("id") ON DELETE cascade,
  "domain" text NOT NULL,
  "authority_score" integer,
  "domain_score" integer,
  "research_sites_linked" integer DEFAULT 0 NOT NULL,
  "total_backlinks" integer DEFAULT 0 NOT NULL,
  "first_seen_at" timestamp with time zone,
  "last_seen_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_referring_domains_run_domain_uq" ON "hht_bl_referring_domains" ("run_id", "domain");
CREATE INDEX IF NOT EXISTS "hht_bl_referring_domains_priority_idx" ON "hht_bl_referring_domains" ("run_id", "research_sites_linked", "authority_score");

CREATE TABLE IF NOT EXISTS "hht_bl_site_referring_domains" (
  "id" serial PRIMARY KEY NOT NULL,
  "research_site_id" integer NOT NULL REFERENCES "hht_bl_research_sites"("id") ON DELETE cascade,
  "referring_domain_id" integer NOT NULL REFERENCES "hht_bl_referring_domains"("id") ON DELETE cascade,
  "backlink_count" integer DEFAULT 0 NOT NULL,
  "raw_response_id" integer REFERENCES "hht_bl_raw_responses"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_site_referring_domains_uq" ON "hht_bl_site_referring_domains" ("research_site_id", "referring_domain_id");

CREATE TABLE IF NOT EXISTS "hht_bl_backlinks" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hht_bl_runs"("id") ON DELETE cascade,
  "research_site_id" integer NOT NULL REFERENCES "hht_bl_research_sites"("id") ON DELETE cascade,
  "referring_domain_id" integer NOT NULL REFERENCES "hht_bl_referring_domains"("id") ON DELETE cascade,
  "raw_response_id" integer REFERENCES "hht_bl_raw_responses"("id") ON DELETE set null,
  "exact_key" text NOT NULL,
  "state" text DEFAULT 'DISCOVERED' NOT NULL,
  "source_url_raw" text NOT NULL,
  "source_url" text NOT NULL,
  "source_title" text,
  "target_url_raw" text NOT NULL,
  "target_url" text NOT NULL,
  "target_title" text,
  "anchor" text,
  "follow" boolean,
  "first_seen_at" timestamp with time zone,
  "last_seen_at" timestamp with time zone,
  "authority_score" integer,
  "source_page_score" integer,
  "response_code" integer,
  "link_type" text,
  "placement" text,
  "language" text,
  "country" text,
  "sitewide" boolean,
  "new_link" boolean,
  "lost_link" boolean,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_backlinks_exact_uq" ON "hht_bl_backlinks" ("run_id", "exact_key");
CREATE INDEX IF NOT EXISTS "hht_bl_backlinks_state_idx" ON "hht_bl_backlinks" ("run_id", "state", "follow");
CREATE INDEX IF NOT EXISTS "hht_bl_backlinks_source_idx" ON "hht_bl_backlinks" ("referring_domain_id");

CREATE TABLE IF NOT EXISTS "hht_bl_crawl_results" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hht_bl_runs"("id") ON DELETE cascade,
  "url" text NOT NULL,
  "kind" text NOT NULL,
  "http_status" integer,
  "canonical_url" text,
  "title" text,
  "page_text" text,
  "raw_html" text,
  "content_hash" text,
  "attempts" integer DEFAULT 1 NOT NULL,
  "error" text,
  "crawled_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_crawl_results_run_url_uq" ON "hht_bl_crawl_results" ("run_id", "url", "kind");
CREATE INDEX IF NOT EXISTS "hht_bl_crawl_results_status_idx" ON "hht_bl_crawl_results" ("run_id", "http_status");

CREATE TABLE IF NOT EXISTS "hht_bl_link_contexts" (
  "id" serial PRIMARY KEY NOT NULL,
  "backlink_id" integer NOT NULL REFERENCES "hht_bl_backlinks"("id") ON DELETE cascade,
  "source_crawl_id" integer REFERENCES "hht_bl_crawl_results"("id") ON DELETE set null,
  "target_crawl_id" integer REFERENCES "hht_bl_crawl_results"("id") ON DELETE set null,
  "located" boolean NOT NULL,
  "anchor" text,
  "surrounding_paragraph" text,
  "surrounding_section" text,
  "heading_hierarchy" jsonb,
  "nearby_outbound_links" jsonb,
  "dom_context" text,
  "target_summary" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_link_contexts_backlink_uq" ON "hht_bl_link_contexts" ("backlink_id");

CREATE TABLE IF NOT EXISTS "hht_bl_link_analyses" (
  "id" serial PRIMARY KEY NOT NULL,
  "backlink_id" integer NOT NULL REFERENCES "hht_bl_backlinks"("id") ON DELETE cascade,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "mechanism" text NOT NULL,
  "mechanism_confidence" double precision NOT NULL,
  "editorial" boolean NOT NULL,
  "likely_paid" boolean NOT NULL,
  "replicable" boolean NOT NULL,
  "replicability_score" integer NOT NULL,
  "hotel_hottubs_relevance" integer NOT NULL,
  "requires_new_asset" boolean NOT NULL,
  "required_asset_type" text,
  "likely_contact_role" text,
  "recommended_action" text NOT NULL,
  "facts" jsonb NOT NULL,
  "inferences" jsonb NOT NULL,
  "evidence" jsonb NOT NULL,
  "raw_output" jsonb NOT NULL,
  "analyzed_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_link_analyses_backlink_uq" ON "hht_bl_link_analyses" ("backlink_id");
CREATE INDEX IF NOT EXISTS "hht_bl_link_analyses_mechanism_idx" ON "hht_bl_link_analyses" ("mechanism");

CREATE TABLE IF NOT EXISTS "hht_bl_opportunities" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hht_bl_runs"("id") ON DELETE cascade,
  "backlink_id" integer NOT NULL REFERENCES "hht_bl_backlinks"("id") ON DELETE cascade,
  "status" text DEFAULT 'IDENTIFIED' NOT NULL,
  "link_value" integer NOT NULL,
  "gettability" integer NOT NULL,
  "transferability" integer NOT NULL,
  "effort" integer NOT NULL,
  "overall_score" double precision NOT NULL,
  "expected_value" double precision NOT NULL,
  "score_inputs" jsonb NOT NULL,
  "rank" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_opportunities_backlink_uq" ON "hht_bl_opportunities" ("backlink_id");
CREATE INDEX IF NOT EXISTS "hht_bl_opportunities_rank_idx" ON "hht_bl_opportunities" ("run_id", "rank", "overall_score");

CREATE TABLE IF NOT EXISTS "hht_bl_strategy_clusters" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hht_bl_runs"("id") ON DELETE cascade,
  "mechanism" text NOT NULL,
  "prospect_count" integer NOT NULL,
  "research_sites_observed" integer NOT NULL,
  "median_authority" double precision,
  "average_link_value" double precision NOT NULL,
  "average_gettability" double precision NOT NULL,
  "average_effort" double precision NOT NULL,
  "estimated_campaign_value" double precision NOT NULL,
  "examples" jsonb NOT NULL,
  "recommended_campaign" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_strategy_clusters_mechanism_uq" ON "hht_bl_strategy_clusters" ("run_id", "mechanism");
CREATE INDEX IF NOT EXISTS "hht_bl_strategy_clusters_value_idx" ON "hht_bl_strategy_clusters" ("run_id", "estimated_campaign_value");

CREATE TABLE IF NOT EXISTS "hht_bl_campaign_candidates" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hht_bl_runs"("id") ON DELETE cascade,
  "strategy_cluster_id" integer NOT NULL REFERENCES "hht_bl_strategy_clusters"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "status" text DEFAULT 'IDENTIFIED' NOT NULL,
  "evidence" jsonb NOT NULL,
  "potential_prospects" integer NOT NULL,
  "existing_asset_sufficient" integer DEFAULT 0 NOT NULL,
  "new_asset_required" integer DEFAULT 0 NOT NULL,
  "recommendation" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_campaign_candidates_cluster_uq" ON "hht_bl_campaign_candidates" ("strategy_cluster_id");

CREATE TABLE IF NOT EXISTS "hht_bl_acquired_links" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hht_bl_runs"("id") ON DELETE cascade,
  "opportunity_id" integer REFERENCES "hht_bl_opportunities"("id") ON DELETE set null,
  "source_url" text NOT NULL,
  "target_url" text NOT NULL,
  "follow" boolean,
  "acquisition_mechanism" text,
  "verification_evidence" text,
  "recorded_via" text DEFAULT 'manual' NOT NULL,
  "acquired_at" timestamp with time zone,
  "verified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "hht_bl_acquired_links_source_uq" ON "hht_bl_acquired_links" ("run_id", "source_url", "target_url");

CREATE TABLE IF NOT EXISTS "hht_bl_run_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "hht_bl_runs"("id") ON DELETE cascade,
  "job_id" integer REFERENCES "hht_bl_jobs"("id") ON DELETE set null,
  "stage" text NOT NULL,
  "level" text DEFAULT 'info' NOT NULL,
  "message" text NOT NULL,
  "domain" text,
  "url" text,
  "provider" text,
  "records_processed" integer,
  "records_remaining" integer,
  "retry_count" integer,
  "details" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "hht_bl_run_events_run_idx" ON "hht_bl_run_events" ("run_id", "created_at");
