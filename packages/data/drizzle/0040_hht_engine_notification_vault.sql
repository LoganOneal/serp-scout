CREATE TABLE IF NOT EXISTS hht_engine.crm_outbox (
  id serial PRIMARY KEY,
  publisher_external_id text NOT NULL,
  opportunity_external_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_outbox_opportunity_idx
  ON hht_engine.crm_outbox (opportunity_external_id);

CREATE TABLE IF NOT EXISTS hht_engine.llm_tasks (
  id serial PRIMARY KEY,
  task_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  input jsonb NOT NULL,
  output_schema jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  answer jsonb,
  parked_job_id integer,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS llm_tasks_entity_idx
  ON hht_engine.llm_tasks (task_type, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS llm_tasks_status_idx ON hht_engine.llm_tasks (status);

CREATE TABLE IF NOT EXISTS hht_engine.run_locks (
  name text PRIMARY KEY,
  owner text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hht_engine.runs (
  id text PRIMARY KEY,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  jobs_completed integer NOT NULL DEFAULT 0,
  semrush_units integer NOT NULL DEFAULT 0,
  google_ads_calls integer NOT NULL DEFAULT 0,
  outbox_rows integer NOT NULL DEFAULT 0,
  error text
);

CREATE TABLE IF NOT EXISTS hht_engine.embeddings (
  id serial PRIMARY KEY,
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  model text NOT NULL,
  embedding vector(384) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS embeddings_entity_idx
  ON hht_engine.embeddings (entity_type, entity_key, model);

CREATE TABLE IF NOT EXISTS hht_engine.google_ads_usage (
  id serial PRIMARY KEY,
  operation text NOT NULL,
  job_id integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE hht_engine.system_state
  ADD COLUMN IF NOT EXISTS semrush_remaining_units integer,
  ADD COLUMN IF NOT EXISTS semrush_account_marker text,
  ADD COLUMN IF NOT EXISTS consecutive_failed_runs integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS consecutive_timed_out_runs integer NOT NULL DEFAULT 0;

ALTER TABLE hht_engine.notifications
  ADD COLUMN IF NOT EXISTS event_type text,
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

ALTER TABLE hht_engine.semrush_usage
  ADD COLUMN IF NOT EXISTS remaining_units integer,
  ADD COLUMN IF NOT EXISTS account_marker text;

DO $$
DECLARE table_name text;
BEGIN
  FOR table_name IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'hht_engine'
  LOOP
    EXECUTE format('ALTER TABLE hht_engine.%I ENABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$$;
