-- Queued SERP purchasing: $0.0006 vs $0.0020 live, a 70% saving.

ALTER TABLE "discovery_jobs"
  -- Losing this loses a SERP we have already paid for: task_get is addressable
  -- only by id, and DataForSEO discards results after a few days.
  ADD COLUMN IF NOT EXISTS "queued_task_id" text,
  ADD COLUMN IF NOT EXISTS "queued_posted_at" timestamp with time zone;

ALTER TABLE "discovery_runs"
  ADD COLUMN IF NOT EXISTS "use_queued_serp" boolean NOT NULL DEFAULT false;

-- Collector lookup: awaiting jobs, oldest first.
CREATE INDEX IF NOT EXISTS "discovery_jobs_awaiting_idx"
  ON "discovery_jobs" ("status", "queued_posted_at")
  WHERE "queued_task_id" IS NOT NULL;
