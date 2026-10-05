-- Connect Vercel: a user's own deploy target (Settings -> Connections).
-- Deploy resolution tries the run owner's token first, then the platform's
-- (VERCEL_TOKEN env or Admin -> Infrastructure) — same pattern as GitHub.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "vercel_token_encrypted" text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "vercel_team_id" text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "vercel_account" text;
