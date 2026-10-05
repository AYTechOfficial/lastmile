-- Which GitHub identity hosts this user's generated code.
--   auto     = their linked GitHub account when they connected one, else the
--              platform-hosted account (today's behaviour)
--   account  = always their own linked GitHub account
--   platform = always the platform-hosted account (Admin -> Infrastructure)
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "github_host" text NOT NULL DEFAULT 'auto';