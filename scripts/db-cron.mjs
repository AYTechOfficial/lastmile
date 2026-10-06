#!/usr/bin/env node
/* Wire the database's own timer.

   GitHub's `schedule` trigger is documented as best-effort and, in practice,
   did not fire for tens of minutes. The queue already lives in Postgres, so the
   timer that notices stranded work belongs there too: pg_cron fires the job,
   pg_net makes the HTTP call, and the app decides whether a runner is needed.

   What this sets up, and the privilege story behind it:

     · The wake secret is stored in Supabase Vault, not in the job's SQL. The
       cron job stores a *query* that reads the secret when it runs, so the
       secret is never written into `cron.job` in plaintext.
     · What the database is trusted with is the doorbell, not a GitHub token.
       It can reclaim leases and wake a runner; it cannot read a run, touch user
       data, or reach the repositories. Rotating a leaked secret costs nothing
       but a re-run of this script.

   Idempotent: re-running enables nothing twice, updates the secret in place, and
   reschedules the job under the same name.

     node scripts/db-cron.mjs [--url https://your-app/api/runner/wake] */

import { config } from "dotenv";
import postgres from "postgres";

config({ path: ".env.local", quiet: true });

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is not set in .env.local");
  process.exit(1);
}

const secret = process.env.WAKE_SECRET?.trim();
if (!secret) {
  console.error(
    "WAKE_SECRET is not set in .env.local — generate one with:\n" +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
  );
  process.exit(1);
}

const urlFlag = process.argv.indexOf("--url");
const target =
  (urlFlag >= 0 ? process.argv[urlFlag + 1] : undefined) ??
  process.env.WAKE_URL?.trim() ??
  "";

if (!target || !/^https?:\/\//.test(target)) {
  console.error(
    "No wake URL. Set WAKE_URL in .env.local or pass --url https://your-app/api/runner/wake",
  );
  process.exit(1);
}

/* A base64url secret contains no quotes, so it is safe inside SQL literals; the
   check is here so a hand-edited secret cannot break the job's SQL. */
if (!/^[A-Za-z0-9_-]+$/.test(secret)) {
  console.error("WAKE_SECRET must be base64url (A-Z, a-z, 0-9, -, _) to embed safely in SQL");
  process.exit(1);
}

const JOB = "lastmile-wake";
const SECRET_NAME = "lastmile_wake_secret";

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 15 });

try {
  console.log("target:", target);
  console.log();

  console.log("extensions:");
  for (const ext of ["pg_cron", "pg_net"]) {
    try {
      await sql.unsafe(`create extension if not exists ${ext}`);
      console.log(`  OK    ${ext} enabled`);
    } catch (error) {
      console.log(`  FAIL  ${ext} — ${error instanceof Error ? error.message : error}`);
      console.log("\nEnable it from the Supabase Dashboard: Database → Extensions.");
      process.exitCode = 1;
      throw new Error(`cannot continue without ${ext}`);
    }
  }

  /* Vault: update in place when it already exists, so rotating is one command
     and never leaves two secrets with the same name. */
  const existing = await sql`select id from vault.secrets where name = ${SECRET_NAME} limit 1`;
  if (existing.length > 0) {
    await sql`select vault.update_secret(${existing[0].id}, ${secret})`;
    console.log(`\nvault: updated ${SECRET_NAME}`);
  } else {
    await sql`select vault.create_secret(${secret}, ${SECRET_NAME}, ${"Shared secret for the app's /api/runner/wake endpoint"})`;
    console.log(`\nvault: created ${SECRET_NAME}`);
  }

  /* The command reads the secret at run time rather than containing it, which
     is the whole point of involving vault. */
  const command = `
select net.http_post(
  url := ${literal(target)},
  body := '{}'::jsonb,
  headers := jsonb_build_object(
    'content-type', 'application/json',
    'x-wake-secret',
    (select decrypted_secret from vault.decrypted_secrets where name = ${literal(SECRET_NAME)})
  ),
  timeout_milliseconds := 10000
);`;

  await sql`select cron.schedule(${JOB}, ${"*/2 * * * *"}, ${command})`;
  console.log(`cron: scheduled ${JOB} every 2 minutes`);

  const jobs = await sql`select jobid, schedule, jobname, active from cron.job order by jobid`;
  console.log("\n=== cron.job ===");
  for (const j of jobs) {
    console.log(`  ${j.jobid}  ${j.schedule}  ${j.jobname}  active=${j.active}`);
  }

  /* Prove the secret is not sitting in the job definition. */
  const [job] = await sql`select command from cron.job where jobname = ${JOB}`;
  const leaks = job ? job.command.includes(secret) : false;
  console.log(`\nsecret present in cron.job SQL: ${leaks ? "YES (bad)" : "no"}`);

  const runs = await sql`
    select jobid, status, return_message, start_time
      from cron.job_run_details
     order by start_time desc
     limit 5
  `;
  console.log("\n=== recent cron.job_run_details ===");
  if (runs.length === 0) console.log("  (none yet — the first run lands within 2 minutes)");
  for (const r of runs) {
    console.log(`  job ${r.jobid} ${r.status} ${r.start_time} :: ${(r.return_message ?? "").slice(0, 90)}`);
  }

  const responses = await sql`
    select id, status_code, error_msg, left(coalesce(content, ''), 120) as content, created
      from net._http_response
     order by created desc
     limit 5
  `;
  console.log("\n=== recent net._http_response ===");
  if (responses.length === 0) console.log("  (none yet)");
  for (const r of responses) {
    console.log(`  #${r.id} ${r.status_code ?? "-"} ${r.created} :: ${(r.error_msg || r.content || "").slice(0, 120)}`);
  }
} catch (error) {
  console.error("setup failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end();
}

function literal(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
