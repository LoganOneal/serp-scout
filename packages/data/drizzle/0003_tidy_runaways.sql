CREATE TABLE "lead_outcomes" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"disposition" text NOT NULL,
	"job_value_micros" bigint,
	"notes" text,
	"recorded_by" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_outcomes" ADD CONSTRAINT "lead_outcomes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lead_outcomes_lead_uq" ON "lead_outcomes" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "lead_outcomes_disposition_idx" ON "lead_outcomes" USING btree ("disposition");