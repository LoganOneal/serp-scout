-- Affiliate directory sites: a property that is not a (locality, niche) cell.
--
-- ==================== WHY sites HAS TO BE RELAXED ====================
-- `sites.locality_id` and `sites.niche_id` were NOT NULL. Both new sites break
-- that, in opposite directions:
--
--   borenhealth.com   has NO locality. Peptides are not geographic, and the
--                     niche corpus is 41 home-service trades.
--   hotelhottubs.com  has ~300 localities and ONE domain. Expressing it as
--                     cells needs 300 rows carrying the same domain, which
--                     sites_domain_uq correctly refuses.
--
-- The cell uniqueness that NOT NULL used to imply is re-established as a partial
-- index scoped to kind='local_lead_gen', in scripts/db-extras.ts. Two affiliate
-- sites both carrying (NULL, NULL) must not collide with each other.
-- =====================================================================

ALTER TABLE "sites"
  ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'local_lead_gen';

ALTER TABLE "sites" ALTER COLUMN "locality_id" DROP NOT NULL;
ALTER TABLE "sites" ALTER COLUMN "niche_id" DROP NOT NULL;

ALTER TABLE "sites"
  ADD COLUMN IF NOT EXISTS "keyword_space" jsonb,
  ADD COLUMN IF NOT EXISTS "affiliate_order_value_micros" bigint,
  ADD COLUMN IF NOT EXISTS "affiliate_commission_rate_bps" integer,
  ADD COLUMN IF NOT EXISTS "affiliate_conversion_rate_bps" integer,
  ADD COLUMN IF NOT EXISTS "platform_verticals" jsonb;

-- Dropped so `pnpm db:extras` recreates it with the kind= predicate. A bare
-- CREATE UNIQUE INDEX IF NOT EXISTS would find the old one and leave it alone.
DROP INDEX IF EXISTS "sites_active_cell_uq";

-- A local cell without its cell is a bug, not a shape. Enforced here rather than
-- by NOT NULL so that affiliate rows are exempt.
ALTER TABLE "sites" DROP CONSTRAINT IF EXISTS "sites_local_cell_complete";
ALTER TABLE "sites" ADD CONSTRAINT "sites_local_cell_complete" CHECK (
  kind <> 'local_lead_gen' OR (locality_id IS NOT NULL AND niche_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Entity sets. `kind = 'locality'` is RESERVED and reads research_geos instead,
-- so the geo corpus (FIPS, population, resolved provider codes) stays the single
-- source of truth for places.

CREATE TABLE IF NOT EXISTS "research_entity_sets" (
  "id" serial PRIMARY KEY NOT NULL,
  "slug" text NOT NULL,
  "kind" text NOT NULL,
  "label" text NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "research_entity_sets_slug_uq"
  ON "research_entity_sets" ("slug");

CREATE TABLE IF NOT EXISTS "research_entities" (
  "id" serial PRIMARY KEY NOT NULL,
  "set_id" integer NOT NULL REFERENCES "research_entity_sets"("id") ON DELETE cascade,
  "slug" text NOT NULL,
  "label" text NOT NULL,
  -- Load-bearing: without aliases the "what do we already rank for" join
  -- under-reports our own coverage, and under-reported coverage reads as an
  -- opportunity — so we would build a page that already exists.
  "aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "attributes" jsonb,
  "priority" integer DEFAULT 0 NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "research_entities_set_slug_uq"
  ON "research_entities" ("set_id", "slug");
CREATE INDEX IF NOT EXISTS "research_entities_active_idx"
  ON "research_entities" ("set_id", "active", "priority");

-- ---------------------------------------------------------------------------
-- One keyword a site targets, with everything measured about it.
--
-- Every measured column pairs with a *_measured_at, because "we looked and there
-- is nothing" and "we never looked" are the same NULL and completely different
-- facts. assessKeyword reads position_measured_at, never position, for exactly
-- that reason.

CREATE TABLE IF NOT EXISTS "site_keyword_targets" (
  "id" serial PRIMARY KEY NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "keyword_id" integer REFERENCES "research_keywords"("id") ON DELETE set null,
  "keyword" text NOT NULL,
  "keyword_norm" text NOT NULL,
  "seed_key" text,
  "pattern_label" text,
  "entities" jsonb,

  "volume" integer,
  "volume_scope" text,
  "volume_measured_at" timestamp with time zone,
  "competition_index" double precision,
  "cpc_micros" bigint,
  "monthly_series" jsonb,

  "position" integer,
  "position_source" text,
  "position_measured_at" timestamp with time zone,
  "ranking_url" text,
  "impressions" integer,
  "clicks" integer,

  "difficulty" integer,
  "difficulty_measured_at" timestamp with time zone,
  "has_ai_overview" boolean,

  "verdict" text,
  "verdict_reason" text,
  "verdict_missing" jsonb,
  "monthly_value_micros" bigint,

  "sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "site_keyword_targets_site_norm_uq"
  ON "site_keyword_targets" ("site_id", "keyword_norm");
CREATE INDEX IF NOT EXISTS "site_keyword_targets_verdict_idx"
  ON "site_keyword_targets" ("site_id", "verdict", "volume");
CREATE INDEX IF NOT EXISTS "site_keyword_targets_volume_idx"
  ON "site_keyword_targets" ("site_id", "active", "volume");

-- ---------------------------------------------------------------------------
-- Competitors, with an explicit peer flag.
--
-- The pre-registered expectation is that hotelhottubs.com's competitor set is
-- Booking, Expedia and TripAdvisor, and that a keyword gap against those is a
-- list of things we cannot rank for dressed as opportunity. `peer` is NULL until
-- somebody decides, and false when explicitly excluded — never absent.

CREATE TABLE IF NOT EXISTS "site_competitors" (
  "id" serial PRIMARY KEY NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "domain" text NOT NULL,
  "source" text NOT NULL,
  "intersections" integer,
  "ranked_keywords" integer,
  "referring_domains" integer,
  "peer" boolean,
  "peer_reason" text,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "site_competitors_site_domain_uq"
  ON "site_competitors" ("site_id", "domain");
