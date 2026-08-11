-- Keyword aliases as DATA, so the next coverage gap is a row rather than a deploy.
--
-- Distinct from domain_stems, which are domain-shaped ("garagedoor") and answer
-- "is this DOMAIN about this niche". These answer "does this SEARCH belong to
-- this niche", and are phrase-shaped ("hail damage", "tub to shower").

ALTER TABLE "niches"
  ADD COLUMN IF NOT EXISTS "keyword_aliases" jsonb NOT NULL DEFAULT '[]'::jsonb;
