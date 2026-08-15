-- Link prospecting and guest-post outreach.
--
-- ==================== THE LIST YOU GET IS A LIST OF LINK SELLERS ==========
-- Mining a competitor's backlinks does not return "sites that link to good
-- content in our niche". It returns sites that chose to link to a COMMERCIAL
-- COMPETITOR — which in a commercial niche means sites that sell links.
--
-- That is the feature (a qualified buyer list) and the risk (everyone mines the
-- same competitors and buys from the same sellers). `link_prospect_sources`
-- exists to turn that into a number: GROUP BY prospect, COUNT DISTINCT
-- competitor. One competitor is plausibly editorial; four or more is a
-- marketplace.
-- =========================================================================

CREATE TABLE IF NOT EXISTS "link_prospect_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "site_id" integer REFERENCES "sites"("id") ON DELETE set null,
  -- The competitors mined. Several, because the §0.2 signal needs more than one.
  "competitors" jsonb NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,

  "referring_domains_found" integer DEFAULT 0 NOT NULL,
  "excluded_count" integer DEFAULT 0 NOT NULL,
  "qualified_count" integer DEFAULT 0 NOT NULL,
  -- Non-zero means the run is a SAMPLE, not the set. Reported, never silent.
  "dropped_to_cap" integer DEFAULT 0 NOT NULL,
  "cost_micros" bigint DEFAULT 0 NOT NULL,
  "notes" jsonb,

  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "error" text
);
CREATE INDEX IF NOT EXISTS "link_prospect_runs_site_idx" ON "link_prospect_runs" ("site_id", "status");

CREATE TABLE IF NOT EXISTS "link_prospects" (
  "id" serial PRIMARY KEY NOT NULL,
  "run_id" integer NOT NULL REFERENCES "link_prospect_runs"("id") ON DELETE cascade,
  "domain" text NOT NULL,

  -- DataForSEO `rank`, 0-1000. NOT Moz DA and NOT Semrush AS — we hold neither.
  "dfs_rank" integer,
  "referring_domains" integer,
  "spam_score" integer,
  -- THE FIRST GATE. Authority is manufacturable; ranking for real queries is not.
  "ranked_keywords" integer,
  "organic_etv" double precision,

  -- The §0.2 signal, denormalised from link_prospect_sources for sorting.
  "competitor_link_count" integer DEFAULT 0 NOT NULL,
  "already_linked" boolean DEFAULT false NOT NULL,

  -- 'PURSUE' | 'MARGINAL' | 'REJECT' | 'UNKNOWN'
  "verdict" text,
  "verdict_reason" text,
  "warnings" jsonb,

  "quality_multiplier" double precision,
  "max_bid_micros" bigint,
  "links_needed" integer,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "link_prospects_run_domain_uq" ON "link_prospects" ("run_id", "domain");
CREATE INDEX IF NOT EXISTS "link_prospects_verdict_idx" ON "link_prospects" ("run_id", "verdict", "max_bid_micros");

-- One row per (prospect, competitor) pair. The GROUP BY that produces §0.2.
CREATE TABLE IF NOT EXISTS "link_prospect_sources" (
  "id" serial PRIMARY KEY NOT NULL,
  "prospect_id" integer NOT NULL REFERENCES "link_prospects"("id") ON DELETE cascade,
  "competitor" text NOT NULL,
  -- The page the link actually sits on. From backlinks/backlinks/live url_from.
  "url_from" text,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "link_prospect_sources_uq"
  ON "link_prospect_sources" ("prospect_id", "competitor");

-- ---------------------------------------------------------------------------
-- Contacts.
--
-- `confidence` is the load-bearing column. 'stated' means the page said who
-- handles this; 'pattern' means we guessed editor@ from a convention. Pattern
-- addresses are excluded from a first send by default, because a bounce costs
-- more than a placement is worth and bounces destroy a sending domain.

CREATE TABLE IF NOT EXISTS "link_contacts" (
  "id" serial PRIMARY KEY NOT NULL,
  "prospect_id" integer NOT NULL REFERENCES "link_prospects"("id") ON DELETE cascade,
  "email" text,
  "name" text,
  "role" text,
  -- 'stated' | 'pattern' | 'form_only' | 'none'
  "confidence" text NOT NULL,
  -- Verbatim quote from the page supporting each field. Never paraphrased.
  "evidence" text,
  "source_url" text,
  -- Did the page publish guest-post terms, and any price it named?
  "guest_post_terms" text,
  "stated_price_micros" bigint,

  "verified_at" timestamp with time zone,
  "bounce_state" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "link_contacts_prospect_idx" ON "link_contacts" ("prospect_id", "confidence");

-- ---------------------------------------------------------------------------
-- Outreach.

CREATE TABLE IF NOT EXISTS "outreach_campaigns" (
  "id" serial PRIMARY KEY NOT NULL,
  "site_id" integer NOT NULL REFERENCES "sites"("id") ON DELETE cascade,
  "run_id" integer REFERENCES "link_prospect_runs"("id") ON DELETE set null,
  "name" text NOT NULL,
  -- 'draft' | 'sending' | 'done' | 'abandoned'
  "status" text DEFAULT 'draft' NOT NULL,

  -- Sender identity. CAN-SPAM requires an accurate sender and a real address.
  "from_name" text,
  "from_email" text,
  "postal_address" text,

  "daily_send_cap" integer DEFAULT 25 NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "outreach_messages" (
  "id" serial PRIMARY KEY NOT NULL,
  "campaign_id" integer NOT NULL REFERENCES "outreach_campaigns"("id") ON DELETE cascade,
  "contact_id" integer NOT NULL REFERENCES "link_contacts"("id") ON DELETE cascade,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  -- 'draft' | 'approved' | 'sent' | 'replied' | 'bounced' | 'blocked'
  "status" text DEFAULT 'draft' NOT NULL,
  -- Why a message was blocked pre-send. Suppression, unresolved merge field, etc.
  "blocked_reason" text,
  -- Facts used to personalise, each with where it came from. No unsourced claims.
  "personalisation" jsonb,
  -- lemlist / provider id, once sending is wired to one.
  "external_id" text,
  "sent_at" timestamp with time zone,
  "replied_at" timestamp with time zone,
  "outcome" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_messages_campaign_contact_uq"
  ON "outreach_messages" ("campaign_id", "contact_id");
CREATE INDEX IF NOT EXISTS "outreach_messages_status_idx" ON "outreach_messages" ("campaign_id", "status");

-- Checked before EVERY send, on email AND domain.
--
-- Built before drafting rather than after, because retrofitting a suppression
-- check is how a "no" gets emailed twice.
CREATE TABLE IF NOT EXISTS "outreach_suppressions" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" text,
  "domain" text,
  "reason" text NOT NULL,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "outreach_suppressions_target" CHECK (email IS NOT NULL OR domain IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_suppressions_email_uq"
  ON "outreach_suppressions" ("email") WHERE "email" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_suppressions_domain_uq"
  ON "outreach_suppressions" ("domain") WHERE "domain" IS NOT NULL;
