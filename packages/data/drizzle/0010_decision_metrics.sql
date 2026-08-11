-- Decision-card metrics: seasonality, CPC, top organic, GBP leaders, Maps once/cell.
ALTER TABLE discovery_serp_metrics
  ADD COLUMN IF NOT EXISTS monthly_searches jsonb,
  ADD COLUMN IF NOT EXISTS serp_competition_index integer,
  ADD COLUMN IF NOT EXISTS serp_competition text,
  ADD COLUMN IF NOT EXISTS cpc_micros bigint,
  ADD COLUMN IF NOT EXISTS low_top_of_page_bid_micros bigint,
  ADD COLUMN IF NOT EXISTS high_top_of_page_bid_micros bigint,
  ADD COLUMN IF NOT EXISTS top_organic_domains jsonb,
  ADD COLUMN IF NOT EXISTS gbp_leaders jsonb,
  ADD COLUMN IF NOT EXISTS has_ai_overview boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_people_also_ask boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS maps_entry_count integer,
  ADD COLUMN IF NOT EXISTS maps_domains jsonb,
  ADD COLUMN IF NOT EXISTS maps_keyword text;
