-- Supply: a read model of what a directory site actually has to sell.
--
-- ==================== PULL, NEVER PUSH ====================
-- The site owns supply. There is no write path from here back to it, and adding
-- one would create two catalogues that disagree — the same failure this repo
-- already paid for with `sites.status` vs `shortlist_items.state`:
--
--   "Two state machines that both claim to describe the same asset diverge
--    silently."
--
-- Supply has that shape and worse consequences. A listing that exists here and
-- not on the site is a page that 404s; a price authoritative in two places is a
-- price that is wrong in one.
-- ==========================================================
--
-- ==================== AND WHY THIS IS A GATE ==============
-- `expandKeywordSpace` produced 975 keywords for hotelhottubs.com knowing
-- nothing about inventory, so `assessKeyword` could return BUILD for a locality
-- with no hotels and `assessPaidKeyword` could return BUY and spend CPC on a
-- click that lands on an empty result set. These tables are what close that.
-- ==========================================================

CREATE TABLE IF NOT EXISTS "supply_sources" (
  "id" serial PRIMARY KEY NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  -- Where the @rnr/supply-feed package is mounted. No trailing slash.
  "base_url" text NOT NULL,
  -- The NAME of the env var holding the bearer token, never the token itself.
  -- A secret in a database row is a secret in every backup and every pg_dump.
  "token_env_var" text NOT NULL DEFAULT 'SUPPLY_FEED_TOKEN',
  -- Which entity dimension a listing's location resolves against. 'locality'
  -- for hotelhottubs; NULL for a catalogue with no geography at all.
  "entity_kind" text DEFAULT 'locality',
  "schema_version" integer,
  -- The last manifest, verbatim. THE BASELINE A PARTIAL SYNC IS DETECTED
  -- AGAINST — without it, pulling 4,000 of 5,231 items is indistinguishable
  -- from a catalogue that shrank.
  "last_manifest" jsonb,
  "last_pulled_at" timestamp with time zone,
  "active" boolean DEFAULT true NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "supply_sources_site_url_uq"
  ON "supply_sources" ("site_id", "base_url");

-- ---------------------------------------------------------------------------
-- Suppliers: a hotel property, a peptide vendor.

CREATE TABLE IF NOT EXISTS "supply_suppliers" (
  "id" serial PRIMARY KEY NOT NULL,
  "source_id" integer NOT NULL REFERENCES "supply_sources"("id") ON DELETE cascade,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  -- Theirs. We never mint one — a synthesised key duplicates on re-order.
  "external_id" text NOT NULL,
  "name" text NOT NULL,

  -- Verbatim, as published. Kept so a wrong resolution can be audited, exactly
  -- like `localities.raw_name`.
  "raw_city" text,
  "raw_region" text,
  "raw_country" text,

  -- ==================== NULL HERE IS 'UNKNOWN', NOT 'NOWHERE' ==============
  -- An unresolved supplier is UNKNOWN coverage and must never be counted as a
  -- zero for any locality. `resolve_status` says which happened, so a screen can
  -- distinguish "we have no listings in Boise" from "we could not work out where
  -- these listings are" — the first is a reason not to build a page, the second
  -- is a reason to fix an importer.
  -- =========================================================================
  "entity_kind" text,
  "entity_slug" text,
  "locality_id" integer REFERENCES "localities"("id") ON DELETE set null,
  -- 'resolved' | 'unresolved' | 'not_applicable'
  "resolve_status" text DEFAULT 'unresolved' NOT NULL,
  "resolve_method" text,
  "unresolved_reason" text,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "supply_suppliers_source_external_uq"
  ON "supply_suppliers" ("source_id", "external_id");
CREATE INDEX IF NOT EXISTS "supply_suppliers_entity_idx"
  ON "supply_suppliers" ("site_id", "entity_kind", "entity_slug");
CREATE INDEX IF NOT EXISTS "supply_suppliers_resolve_idx"
  ON "supply_suppliers" ("source_id", "resolve_status");

-- ---------------------------------------------------------------------------
-- Items: a room, a product.

CREATE TABLE IF NOT EXISTS "supply_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "source_id" integer NOT NULL REFERENCES "supply_sources"("id") ON DELETE cascade,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "supplier_id" integer NOT NULL REFERENCES "supply_suppliers"("id") ON DELETE cascade,
  "external_id" text NOT NULL,

  "title" text NOT NULL,
  "url" text NOT NULL,
  "affiliate_url" text,
  "attributes" jsonb,
  -- Integer micros, always. A float price rounds into a median that is quietly
  -- wrong and then authorises ad spend. See @rnr/core money.ts.
  "price_micros" bigint,
  "currency" text,
  -- NULLABLE ON PURPOSE. The publisher omitting `available` means UNKNOWN, and
  -- unknown must not be counted as bookable — that is how a sold-out city keeps
  -- its BUILD verdict.
  "available" boolean,
  "images" jsonb,

  -- ==================== TWO CLOCKS, DELIBERATELY APART ====================
  -- `source_updated_at` is THEIRS: when the row last changed on their site.
  -- `last_seen_at` is OURS: when we last confirmed it exists.
  -- Collapsing them loses the ability to tell *stale* from *unchanged*.
  -- =======================================================================
  "source_updated_at" timestamp with time zone,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- SOFT delete. An item absent from a full sync is marked gone; it is never
  -- DELETEd. A feed outage returning an empty page would otherwise erase the
  -- catalogue and report a portfolio-wide supply gap that never existed.
  "gone_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "supply_items_source_external_uq"
  ON "supply_items" ("source_id", "external_id");
CREATE INDEX IF NOT EXISTS "supply_items_supplier_idx"
  ON "supply_items" ("supplier_id", "gone_at");
CREATE INDEX IF NOT EXISTS "supply_items_site_idx"
  ON "supply_items" ("site_id", "gone_at", "available");

-- ---------------------------------------------------------------------------
-- Coverage: the materialised join the rest of the system reads.
--
-- Recomputed per ingest rather than per query. It is read by the keyword board,
-- the ads planner and every agent call, and recomputing a 195-locality aggregate
-- on each of those is waste.

CREATE TABLE IF NOT EXISTS "supply_coverage" (
  "id" serial PRIMARY KEY NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "entity_kind" text NOT NULL,
  "entity_slug" text NOT NULL,

  "supplier_count" integer DEFAULT 0 NOT NULL,
  "item_count" integer DEFAULT 0 NOT NULL,
  -- What the gate reads. NOT item_count — see supply_items.available.
  "available_item_count" integer DEFAULT 0 NOT NULL,
  "min_price_micros" bigint,
  "median_price_micros" bigint,

  -- Ours. A locality unseen for 30 days is one where something upstream broke,
  -- and it must read as stale rather than as absent.
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "supply_coverage_uq"
  ON "supply_coverage" ("site_id", "entity_kind", "entity_slug");
CREATE INDEX IF NOT EXISTS "supply_coverage_available_idx"
  ON "supply_coverage" ("site_id", "available_item_count");

-- ---------------------------------------------------------------------------
-- Ingest runs.
--
-- `unresolved_suppliers` and `manifest_total_items` are the two columns that
-- make a bad run visible. An ingest that resolves 60% of localities is a
-- coverage map that is 40% wrong in the optimistic direction, and a pull whose
-- item count does not match the manifest is a partial sync.

CREATE TABLE IF NOT EXISTS "supply_ingest_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "source_id" integer NOT NULL REFERENCES "supply_sources"("id") ON DELETE cascade,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  -- 'running' | 'ok' | 'partial' | 'failed'
  "status" text DEFAULT 'running' NOT NULL,
  -- Full walk, or `?since=` incremental. A soft-delete sweep is only valid on a
  -- full one — an incremental pull legitimately omits everything unchanged.
  "mode" text DEFAULT 'full' NOT NULL,

  "pages_fetched" integer DEFAULT 0 NOT NULL,
  "items_pulled" integer DEFAULT 0 NOT NULL,
  "items_upserted" integer DEFAULT 0 NOT NULL,
  "items_marked_gone" integer DEFAULT 0 NOT NULL,
  "suppliers_upserted" integer DEFAULT 0 NOT NULL,
  "unresolved_suppliers" integer DEFAULT 0 NOT NULL,
  -- From the publisher's manifest. Compared against items_pulled.
  "manifest_total_items" integer,
  "manifest_invalid_items" integer,
  "entities_covered" integer DEFAULT 0 NOT NULL,

  "notes" jsonb,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "error" text
);
CREATE INDEX IF NOT EXISTS "supply_ingest_runs_source_idx"
  ON "supply_ingest_runs" ("source_id", "started_at" DESC);
