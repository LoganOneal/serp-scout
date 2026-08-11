-- A ledger must not forget.
--
-- spend_ledger.discovery_run_id was ON DELETE CASCADE, so deleting a discovery
-- run deleted its spend lines too. Deleting runs is routine here ("delete a run
-- to re-research the same selection"), so the books reset while the DataForSEO
-- balance did not: $51 of lifetime spend reconciled to $2.72 of ledger.
--
-- SET NULL keeps the line and drops only the run association. The note column
-- already carries enough context to attribute an orphaned line.

ALTER TABLE spend_ledger
  DROP CONSTRAINT IF EXISTS spend_ledger_discovery_run_id_discovery_runs_id_fk;

ALTER TABLE spend_ledger
  ADD CONSTRAINT spend_ledger_discovery_run_id_discovery_runs_id_fk
  FOREIGN KEY (discovery_run_id) REFERENCES discovery_runs (id) ON DELETE SET NULL;
