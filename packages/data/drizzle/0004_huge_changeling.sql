CREATE TABLE "serp_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"target_id" integer NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"serp_measured" boolean DEFAULT false NOT NULL,
	"serp_position" integer,
	"our_domain_position" integer,
	"comment_rank" integer,
	"comment_total" integer,
	"comment_present" boolean,
	"measured_via" text,
	"error" text,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "serp_keywords" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"keyword" text NOT NULL,
	"volume" integer,
	"difficulty" integer,
	"cpc_micros" bigint,
	"semrush_position" integer,
	"semrush_url" text,
	"import_batch" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "serp_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"keyword_id" integer NOT NULL,
	"url" text NOT NULL,
	"platform" text DEFAULT 'reddit' NOT NULL,
	"reddit_post_id" text,
	"comment_permalink" text,
	"comment_id" text,
	"label" text,
	"active" boolean DEFAULT true NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sites" ALTER COLUMN "domain" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "serp_checks" ADD CONSTRAINT "serp_checks_target_id_serp_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."serp_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_keywords" ADD CONSTRAINT "serp_keywords_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_targets" ADD CONSTRAINT "serp_targets_keyword_id_serp_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."serp_keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "serp_checks_target_time_idx" ON "serp_checks" USING btree ("target_id","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "serp_keywords_site_keyword_uq" ON "serp_keywords" USING btree ("site_id","keyword");--> statement-breakpoint
CREATE INDEX "serp_keywords_active_idx" ON "serp_keywords" USING btree ("site_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "serp_targets_keyword_url_uq" ON "serp_targets" USING btree ("keyword_id","url");--> statement-breakpoint
CREATE INDEX "serp_targets_claim_idx" ON "serp_targets" USING btree ("active","next_check_at");