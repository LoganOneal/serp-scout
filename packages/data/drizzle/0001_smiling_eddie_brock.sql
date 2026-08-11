CREATE TABLE "retell_agents" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"agent_name" text,
	"response_engine_type" text,
	"conversation_flow_id" text,
	"version" integer,
	"is_published" boolean,
	"voice_id" text,
	"language" text,
	"webhook_url" text,
	"post_call_analysis_fields" jsonb,
	"data_storage_setting" text,
	"node_count" integer,
	"tool_names" jsonb,
	"remote_agent" jsonb,
	"remote_flow" jsonb,
	"source" text DEFAULT 'api' NOT NULL,
	"pulled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "retell_agents_pulled_idx" ON "retell_agents" USING btree ("pulled_at");