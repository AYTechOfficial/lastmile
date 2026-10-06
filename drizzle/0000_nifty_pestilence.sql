CREATE SCHEMA "lastmile";
--> statement-breakpoint
CREATE TABLE "lastmile"."account" (
	"userId" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "account_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "lastmile"."agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"iteration" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider" text,
	"model" text,
	"tokens" integer DEFAULT 0 NOT NULL,
	"elapsed_ms" integer,
	"detail" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lastmile"."jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"lease_ms" integer DEFAULT 900000 NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lastmile"."platform_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lastmile"."run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"stage" text NOT NULL,
	"kind" text DEFAULT 'info' NOT NULL,
	"line" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lastmile"."run_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"intent" text,
	"assertions" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"failure" text
);
--> statement-breakpoint
CREATE TABLE "lastmile"."run_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"iteration" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"severity" text DEFAULT 'major' NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lastmile"."runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_number" integer NOT NULL,
	"sentence" text NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"current_stage" text DEFAULT 'research' NOT NULL,
	"plan_id" text DEFAULT 'free' NOT NULL,
	"research" jsonb,
	"spec" jsonb,
	"spec_variant" integer DEFAULT 1 NOT NULL,
	"master_prompt" jsonb,
	"conformance" jsonb,
	"test_report" jsonb,
	"iterations" integer DEFAULT 0 NOT NULL,
	"quality_score" integer,
	"repo_owner" text,
	"repo_name" text,
	"repo_url" text,
	"commit_sha" text,
	"live_url" text,
	"deploy_id" text,
	"pipeline_state" jsonb,
	"kill_requested" boolean DEFAULT false NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lastmile"."session" (
	"sessionToken" text PRIMARY KEY NOT NULL,
	"userId" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lastmile"."usage_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day" text NOT NULL,
	"builds" integer DEFAULT 0 NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lastmile"."user_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"key_encrypted" text NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lastmile"."user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text,
	"emailVerified" timestamp with time zone,
	"image" text,
	"password_hash" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"github_host" text DEFAULT 'auto' NOT NULL,
	"github_token_encrypted" text,
	"github_login" text,
	"vercel_token_encrypted" text,
	"vercel_team_id" text,
	"vercel_account" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "lastmile"."verificationToken" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verificationToken_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "lastmile"."account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "lastmile"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lastmile"."agent_runs" ADD CONSTRAINT "agent_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lastmile"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lastmile"."jobs" ADD CONSTRAINT "jobs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lastmile"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lastmile"."run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lastmile"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lastmile"."run_flows" ADD CONSTRAINT "run_flows_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lastmile"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lastmile"."run_issues" ADD CONSTRAINT "run_issues_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "lastmile"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lastmile"."runs" ADD CONSTRAINT "runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "lastmile"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lastmile"."session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "lastmile"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lastmile"."usage_daily" ADD CONSTRAINT "usage_daily_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "lastmile"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lastmile"."user_providers" ADD CONSTRAINT "user_providers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "lastmile"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_run_agent_iter" ON "lastmile"."agent_runs" USING btree ("run_id","agent","iteration");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "lastmile"."jobs" USING btree ("status","run_at","priority");--> statement-breakpoint
CREATE INDEX "jobs_run_idx" ON "lastmile"."jobs" USING btree ("run_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_seq" ON "lastmile"."run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "run_flows_run_pos" ON "lastmile"."run_flows" USING btree ("run_id","position");--> statement-breakpoint
CREATE INDEX "run_issues_run_idx" ON "lastmile"."run_issues" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_user_number" ON "lastmile"."runs" USING btree ("user_id","run_number");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_daily_user_day" ON "lastmile"."usage_daily" USING btree ("user_id","day");