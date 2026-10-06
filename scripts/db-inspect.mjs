#!/usr/bin/env node
/* Read-only inspection of the target database.

   Run before any migration: it answers "what is already here?" without writing
   anything. This matters because the previous build deployed into the same
   database, so the new schema's table names may already be taken.

     node scripts/db-inspect.mjs */

import { config } from "dotenv";
import postgres from "postgres";

config({ path: ".env.local", quiet: true });

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is not set in .env.local");
  process.exit(1);
}

/* prepare:false — Supabase's transaction pooler cannot hold prepared statements. */
const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 15 });

const SYSTEM = [
  "pg_catalog", "information_schema", "pg_toast", "extensions", "pgbouncer",
  "graphql", "graphql_public", "realtime", "storage", "vault",
  "supabase_migrations", "supabase_functions", "auth", "cron", "net",
];

try {
  console.log("host:", new URL(url).host);
  console.log();

  const schemas = await sql`
    select schema_name
      from information_schema.schemata
     order by 1
  `;
  const userSchemas = schemas
    .map((s) => s.schema_name)
    .filter((s) => !SYSTEM.includes(s) && !s.startsWith("pg_"));
  console.log("user schemas:", userSchemas.join(", ") || "(none)");
  console.log();

  const tables = await sql`
    select table_schema, table_name
      from information_schema.tables
     where table_schema = any(${userSchemas})
       and table_type = 'BASE TABLE'
     order by 1, 2
  `;
  console.log(`tables (${tables.length}):`);
  for (const t of tables) console.log(`  ${t.table_schema}.${t.table_name}`);
  console.log();

  /* Row counts on the tables that hold real user data — the ones a careless
     migration would hurt. */
  console.log("row counts:");
  for (const name of ["user", "account", "session", "runs", "run_events", "jobs"]) {
    try {
      const [{ n }] = await sql`
        select count(*)::int as n from ${sql("public")}.${sql(name)}
      `;
      console.log(`  public.${name}: ${n}`);
    } catch {
      console.log(`  public.${name}: (does not exist)`);
    }
  }
  console.log();

  /* Which columns the existing user table has, so a future ALTER is a choice
     rather than a guess. */
  try {
    const cols = await sql`
      select column_name, data_type, is_nullable, column_default
        from information_schema.columns
       where table_schema = 'public' and table_name = 'user'
       order by ordinal_position
    `;
    console.log("public.user columns:");
    for (const c of cols) {
      console.log(
        `  ${c.column_name} ${c.data_type}` +
          (c.is_nullable === "NO" ? " NOT NULL" : "") +
          (c.column_default ? ` default ${String(c.column_default).slice(0, 40)}` : ""),
      );
    }
  } catch {
    /* nothing to report */
  }
} catch (error) {
  console.error("inspection failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
