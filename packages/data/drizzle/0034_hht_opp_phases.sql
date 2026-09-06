ALTER TABLE hht_opp_settings
  ADD COLUMN IF NOT EXISTS competitor_domains jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS hht_opp_authors (
  id serial PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES hht_opp_domains(id) ON DELETE CASCADE,
  name text NOT NULL,
  source_url text NOT NULL,
  source_excerpt text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hht_opp_authors_domain_name_uq ON hht_opp_authors (domain_id, name);

CREATE TABLE IF NOT EXISTS hht_opp_author_publications (
  id serial PRIMARY KEY,
  author_id integer NOT NULL REFERENCES hht_opp_authors(id) ON DELETE CASCADE,
  domain text NOT NULL,
  url text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hht_opp_author_pubs_uq ON hht_opp_author_publications (author_id, domain);

CREATE TABLE IF NOT EXISTS hht_opp_competitor_hits (
  id serial PRIMARY KEY,
  domain_id integer REFERENCES hht_opp_domains(id) ON DELETE SET NULL,
  referring_domain text NOT NULL,
  competitor_count integer NOT NULL,
  competitors jsonb NOT NULL DEFAULT '[]'::jsonb,
  already_links_to_hht boolean NOT NULL DEFAULT false,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hht_opp_competitor_hits_domain_uq ON hht_opp_competitor_hits (referring_domain);

CREATE TABLE IF NOT EXISTS hht_opp_strategy_recommendations (
  id serial PRIMARY KEY,
  summary text NOT NULL,
  rationale text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'proposed',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
