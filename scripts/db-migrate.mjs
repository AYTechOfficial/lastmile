#!/usr/bin/env node
/* Apply the generated migrations, once each.

   A tiny migrator rather than a framework, because the requirement is narrow:
   run every file in drizzle/ that has not run yet, in filename order, each in
   its own transaction, and record it. Re-running is therefore always safe.

   The whole thing lives inside the `lastmile` schema, so a database shared with
   another application is not disturbed.

     node scripts/db-migrate.mjs */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "dotenv";
import postgres from "postgres";

config({ path: ".env.local", quiet: true });

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is not set in .env.local");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 15 });
const dir = resolve(import.meta.dirname, "..", "drizzle");

/* The tracking table cannot be created up front on a fresh database: the
   generated migration creates the `lastmile` schema itself, so creating it here
   would collide. Instead the tracking table is created inside the first
   migration's own transaction, after its body has run. */
const TRACKING_DDL = `
  create table if not exists lastmile._migrations (
    name       text primary key,
    applied_at timestamptz not null default now()
  )
`;

try {
  async function loadApplied() {
    try {
      const rows = await sql`select name from lastmile._migrations`;
      return new Set(rows.map((r) => r.name));
    } catch {
      /* No schema, or no tracking table yet: nothing has been applied. */
      return new Set();
    }
  }

  const applied = await loadApplied();

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.error("No .sql files in drizzle/ — run `npm run db:generate` first.");
    process.exit(1);
  }

  let ran = 0;
  let skipped = 0;

  for (const file of files) {
    if (applied.has(file)) {
      skipped++;
      continue;
    }

    /* drizzle-kit emits `CREATE SCHEMA "lastmile";` unconditionally. That fails
       whenever the schema already exists — which happens as soon as anything
       has touched this database before, including a partially applied run. The
       statement is rewritten to be conditional so a migration is safe to retry.
       This is the only edit made to generated SQL, and it is idempotent. */
    const body = readFileSync(join(dir, file), "utf8").replace(
      /^CREATE SCHEMA ("[^"]+");/m,
      "CREATE SCHEMA IF NOT EXISTS $1;",
    );
    process.stdout.write(`applying ${file} ... `);

    /* One transaction per file: a migration either lands whole or not at all,
       and its bookkeeping row lands with it. `unsafe` is required because a
       migration is many statements; this is our own generated SQL, never user
       input. */
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx.unsafe(TRACKING_DDL);
      await tx`insert into lastmile._migrations (name) values (${file})`;
    });

    console.log("ok");
    ran++;
  }

  console.log(`\n${ran} applied, ${skipped} already present`);

  const tables = await sql`
    select table_name
      from information_schema.tables
     where table_schema = 'lastmile' and table_type = 'BASE TABLE'
     order by 1
  `;
  console.log(`lastmile schema now has ${tables.length} tables:`);
  console.log("  " + tables.map((t) => t.table_name).join(", "));
} catch (error) {
  console.error("\nmigration failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
