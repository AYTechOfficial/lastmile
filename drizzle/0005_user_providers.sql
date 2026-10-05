-- A user's own model endpoints (OpenAI-compatible base URL + key + models).
-- Tried BEFORE the operator's platform providers and before the env-key chain:
-- a key the user pays for should win, and platform capacity is the fallback.
CREATE TABLE IF NOT EXISTS "user_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "label" text NOT NULL,
  "base_url" text NOT NULL,
  "key_encrypted" text NOT NULL,
  "models" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "user_providers" ADD CONSTRAINT "user_providers_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
