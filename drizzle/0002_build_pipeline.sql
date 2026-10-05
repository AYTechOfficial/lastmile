-- 0002 — the autonomous build pipeline.
-- The post-approval stages stop being a planned timeline and become real
-- agents: master prompt → codebase → verify → deploy → live test loop.
-- Idempotent, like 0001.

-- runs: what the pipeline produced and how far the loop got
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "master_prompt" jsonb;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "iterations" integer NOT NULL DEFAULT 0;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "quality_score" integer;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "pipeline_state" jsonb;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "kill_requested" boolean NOT NULL DEFAULT false;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "zip_path" text;

-- structured defects found by the verify + testing agents; this is the queue
-- the quality loop feeds back to the coding agent
CREATE TABLE IF NOT EXISTS "run_issues" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "iteration" integer NOT NULL DEFAULT 0,
  "source" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'major',
  "title" text NOT NULL,
  "detail" text,
  "status" text NOT NULL DEFAULT 'open',
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "run_issues_run_iter" ON "run_issues" ("run_id", "iteration");

-- users: free vs pro plan
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "plan" text NOT NULL DEFAULT 'free';

-- singleton admin settings: provider keys (encrypted at rest), model routing
-- per agent and plan, provider toggles, kill-switch flags
CREATE TABLE IF NOT EXISTS "platform_settings" (
  "id" text PRIMARY KEY,
  "data" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
