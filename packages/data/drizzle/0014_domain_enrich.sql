-- ENRICH MODE: domain availability deep-dive.
--
-- Purely additive: two new tables, nothing existing is altered.

CREATE TABLE IF NOT EXISTS "domain_enrich_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "niche" text NOT NULL,
  "locality" text NOT NULL,
  "location_code" integer NOT NULL,
  "radius_km" integer DEFAULT 25 NOT NULL,
  "max_results" integer DEFAULT 200 NOT NULL,
  "include_closed" boolean DEFAULT true NOT NULL,
  "businesses_found" integer DEFAULT 0 NOT NULL,
  "unique_domains" integer DEFAULT 0 NOT NULL,
  "skipped_platform" integer DEFAULT 0 NOT NULL,
  "skipped_no_domain" integer DEFAULT 0 NOT NULL,
  "cost_micros" bigint DEFAULT 0 NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "domain_enrich_runs_status_idx"
  ON "domain_enrich_runs" ("status", "created_at");

CREATE TABLE IF NOT EXISTS "domain_candidates" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL
    REFERENCES "domain_enrich_runs"("id") ON DELETE CASCADE,
  "domain" text NOT NULL,
  "status" text NOT NULL,
  "reason" text NOT NULL,
  "score" double precision DEFAULT 0 NOT NULL,
  "score_components" jsonb,
  "score_missing" jsonb,
  "businesses" jsonb,
  "business_count" integer DEFAULT 1 NOT NULL,

  -- Stage 3d (RDAP). Nullable throughout: the registry may not have answered,
  -- and "did not answer" must never be stored as a zero or a false.
  "registrar" text,
  "registered_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "age_years" double precision,
  "days_to_expiry" integer,
  "rdap_statuses" jsonb,

  -- Stages 3a-3c triage evidence.
  "http_outcome" text,
  "http_status" integer,
  "redirected_to" text,
  "parking_nameserver" text,

  -- Stage 5a (Majestic). Null until a key is configured.
  "trust_flow" integer,
  "citation_flow" integer,
  "referring_domains" integer,
  "referring_subnets" integer,
  "topics" jsonb,

  -- Stage 5b (Wayback).
  "first_snapshot_at" timestamp with time zone,
  "last_content_snapshot_at" timestamp with time zone,
  "total_snapshots" integer,
  "years_of_content" integer,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "domain_candidates_run_domain_idx"
  ON "domain_candidates" ("run_id", "domain");
CREATE INDEX IF NOT EXISTS "domain_candidates_rank_idx"
  ON "domain_candidates" ("run_id", "score");
CREATE INDEX IF NOT EXISTS "domain_candidates_status_idx"
  ON "domain_candidates" ("run_id", "status");
