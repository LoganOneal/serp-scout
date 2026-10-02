ALTER TABLE hht_engine.opportunities ADD COLUMN IF NOT EXISTS filter_status text;
ALTER TABLE hht_engine.opportunities ADD COLUMN IF NOT EXISTS filter_reasons jsonb;
ALTER TABLE hht_engine.opportunities ADD COLUMN IF NOT EXISTS best_keyword text;
ALTER TABLE hht_engine.opportunities ADD COLUMN IF NOT EXISTS best_position integer;
ALTER TABLE hht_engine.opportunities ADD COLUMN IF NOT EXISTS insertion_suggestion text;
ALTER TABLE hht_engine.opportunities ADD COLUMN IF NOT EXISTS primary_thread boolean NOT NULL DEFAULT false;
ALTER TABLE hht_engine.opportunities ADD COLUMN IF NOT EXISTS publisher_external_id text;

CREATE TABLE IF NOT EXISTS hht_engine.publisher_pages (
  id serial PRIMARY KEY,
  canonical_url text NOT NULL,
  root_domain text NOT NULL,
  title text,
  page_type text,
  links_to_hht boolean,
  links_to_hht_checked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS publisher_pages_url_idx ON hht_engine.publisher_pages (canonical_url);

CREATE TABLE IF NOT EXISTS hht_engine.page_rankings (
  id serial PRIMARY KEY,
  page_id integer NOT NULL,
  keyword_id integer NOT NULL,
  keyword text NOT NULL,
  position integer NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hht_engine.publisher_research (
  id serial PRIMARY KEY,
  root_domain text NOT NULL,
  guest_post_status text,
  evidence_url text,
  requirements text,
  sells_placements boolean NOT NULL DEFAULT false,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS publisher_research_domain_idx ON hht_engine.publisher_research (root_domain);

CREATE TABLE IF NOT EXISTS hht_engine.opportunity_pages (
  id serial PRIMARY KEY,
  opportunity_id integer NOT NULL,
  canonical_url text NOT NULL,
  title text,
  best_position integer NOT NULL,
  keyword text
);
CREATE UNIQUE INDEX IF NOT EXISTS opportunity_pages_idx ON hht_engine.opportunity_pages (opportunity_id, canonical_url);

CREATE TABLE IF NOT EXISTS hht_engine.contacts (
  id serial PRIMARY KEY,
  email_normalized text,
  name text,
  role text,
  email text,
  form_url text,
  method text,
  source text,
  validation_status text NOT NULL DEFAULT 'UNVERIFIED',
  blocked boolean NOT NULL DEFAULT false,
  validated_at timestamptz,
  last_contacted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_idx ON hht_engine.contacts (email_normalized);

CREATE TABLE IF NOT EXISTS hht_engine.contact_domains (
  id serial PRIMARY KEY,
  contact_id integer NOT NULL,
  root_domain text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS contact_domains_idx ON hht_engine.contact_domains (contact_id, root_domain);

CREATE TABLE IF NOT EXISTS hht_engine.drafts (
  id serial PRIMARY KEY,
  opportunity_id integer NOT NULL,
  template_id text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS drafts_opportunity_idx ON hht_engine.drafts (opportunity_id);

CREATE TABLE IF NOT EXISTS hht_engine.responses (
  id serial PRIMARY KEY,
  opportunity_id integer NOT NULL,
  state text NOT NULL,
  price double precision,
  currency text,
  link_attributes text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hht_engine.crm_events (
  id serial PRIMARY KEY,
  opportunity_id integer,
  request_id text NOT NULL,
  result text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hht_engine.keyword_relationships (
  id serial PRIMARY KEY,
  keyword_id integer NOT NULL,
  source_keyword_id integer,
  relation text NOT NULL
);
