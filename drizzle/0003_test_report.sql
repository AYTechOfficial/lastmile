-- 0003 — the live QA report. Stored so the UI can show real console-error and
-- screenshot counts from the browser run instead of inventing numbers.

ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "test_report" jsonb;
