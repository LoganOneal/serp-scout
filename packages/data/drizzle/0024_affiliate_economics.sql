-- Affiliate economics: commission as a contract, conversion as observations.
--
-- ==================== THREE NUMBERS, THREE EPISTEMIC STATUSES ====================
-- `sites.affiliate_*` stores commission, order value and conversion rate as
-- three plain integer columns, which encodes the wrong idea: that they are the
-- same kind of number and differ only in value.
--
--   commission  is a CONTRACT      exact, known, effective-dated
--   order value is a DISTRIBUTION  an average standing in for a spread
--   conversion  is a MEASUREMENT   it has a sample size and an interval
--
-- The third one is why this migration exists. A conversion rate typed in as a
-- number loses the only thing that makes it usable: "3% from 40 clicks" and "3%
-- from 40,000" are different facts and the paid-search model treats them
-- differently or it is not doing its job.
-- ================================================================================

-- Effective-dated commission. `entity_slug IS NULL` is the site default row.
--
-- Effective-dated so a renegotiated rate cannot retroactively rewrite last
-- month's plan. `ads_plans` already freezes what it used; the two together mean
-- a three-month-old plan still explains its own numbers.
CREATE TABLE IF NOT EXISTS "affiliate_commission_rates" (
  "id" serial PRIMARY KEY NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "entity_slug" text,
  "commission_rate_bps" integer NOT NULL,
  "effective_from" date NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- Two indexes, because NULL entity_slug (the site default) is not unique-able
-- in the same index as a non-null one — Postgres treats NULLs as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_commission_rates_entity_uq"
  ON "affiliate_commission_rates" ("site_id", "entity_slug", "effective_from")
  WHERE "entity_slug" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_commission_rates_site_uq"
  ON "affiliate_commission_rates" ("site_id", "effective_from")
  WHERE "entity_slug" IS NULL;

-- The only place conversion data enters.
--
-- `clicks` and `orders` are NOT NULL and there is deliberately NO column for a
-- bare rate. That is what makes "enter the observation, not the rate"
-- structural rather than a convention someone skips on a busy afternoon.
CREATE TABLE IF NOT EXISTS "affiliate_observations" (
  "id" serial PRIMARY KEY NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  -- site | entity | pattern | keyword
  "scope_kind" text NOT NULL,
  -- entity slug / pattern label / keyword_norm. NULL only when scope_kind='site'.
  "scope_ref" text,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "clicks" integer NOT NULL,
  "orders" integer NOT NULL,
  -- Gross sale value. NULL when the report omits it — then AOV is underivable.
  "sale_value_micros" bigint,
  -- What actually landed. Divided by sale value this gives the EFFECTIVE
  -- commission, which is worth having even when the contract says 7.5%.
  "commission_micros" bigint,
  "source" text DEFAULT 'manual' NOT NULL,
  "entered_by" text,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  -- A negative or impossible observation is a typo, not data.
  CONSTRAINT "affiliate_observations_sane" CHECK (
    clicks >= 0 AND orders >= 0 AND orders <= clicks AND period_end >= period_start
  )
);
CREATE INDEX IF NOT EXISTS "affiliate_observations_scope_idx"
  ON "affiliate_observations" ("site_id", "scope_kind", "scope_ref");

-- Order value per entity reuses research_entities.attributes — it exists for
-- exactly this ("a $600 peptide and a $40 one are not worth the same click")
-- and a fourth table for one number per row is not worth the join.
