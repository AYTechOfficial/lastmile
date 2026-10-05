-- 0001 — the real agent engine.
-- Idempotent on purpose: this repo has no migration history yet (the schema was
-- created with `drizzle-kit push`), so this file can be applied to an existing
-- database and re-applied safely.

-- runs: how a run advances, what research backed it, and how it failed
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "engine" text NOT NULL DEFAULT 'stub';
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "research" jsonb;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "error" text;

-- one row per agent invocation
CREATE TABLE IF NOT EXISTS "agent_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "agent" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "provider" text,
  "model" text,
  "tokens" integer NOT NULL DEFAULT 0,
  "elapsed_ms" integer,
  "detail" text,
  "error" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "ended_at" timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_runs_run_agent" ON "agent_runs" ("run_id", "agent");

-- cheap lookups for the run list and the live activity feed
CREATE INDEX IF NOT EXISTS "runs_user_created" ON "runs" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "run_events_run_seq" ON "run_events" ("run_id", "seq");
