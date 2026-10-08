ALTER TABLE hht_engine.domains
  ADD COLUMN IF NOT EXISTS pitch_call text,
  ADD COLUMN IF NOT EXISTS pitch_call_url text,
  ADD COLUMN IF NOT EXISTS pitch_call_quote text,
  ADD COLUMN IF NOT EXISTS pitch_call_at timestamptz;
