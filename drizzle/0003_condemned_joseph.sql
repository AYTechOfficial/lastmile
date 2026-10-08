CREATE TABLE IF NOT EXISTS "lastmile"."credit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid,
	"delta_milli" integer NOT NULL,
	"balance_milli" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lastmile"."user" ADD COLUMN IF NOT EXISTS "credits_milli" integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "lastmile"."user" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lastmile"."credit_events" ADD CONSTRAINT "credit_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "lastmile"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "lastmile"."credit_events" ADD CONSTRAINT "credit_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lastmile"."runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_events_user_idx" ON "lastmile"."credit_events" USING btree ("user_id","created_at");
