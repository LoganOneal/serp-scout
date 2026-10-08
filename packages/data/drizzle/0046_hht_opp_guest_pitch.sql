ALTER TABLE hht_opp_guest_evaluations
  ADD COLUMN IF NOT EXISTS pitch_subject text,
  ADD COLUMN IF NOT EXISTS pitch_angle text,
  ADD COLUMN IF NOT EXISTS pitch_body text,
  ADD COLUMN IF NOT EXISTS pitch_drafted_at timestamptz;
