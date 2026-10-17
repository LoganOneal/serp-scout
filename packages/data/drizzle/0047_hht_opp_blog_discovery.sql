ALTER TABLE hht_opp_guest_keywords
  ADD COLUMN IF NOT EXISTS bucket text,
  ADD COLUMN IF NOT EXISTS priority integer,
  ADD COLUMN IF NOT EXISTS lead_type text,
  ADD COLUMN IF NOT EXISTS results_seen integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qualified_domains integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pitched_domains integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_run_at timestamptz;
