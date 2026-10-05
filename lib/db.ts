import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema";

/* Supabase Postgres over the Supavisor session pooler (IPv4-safe on every
   host). prepare:false is required by the pooler.

   IMPORTANT — why there is no module-scope throw here:
   `next build` imports this module while collecting page data (via
   lib/auth.ts and the /api routes). A missing DATABASE_URL therefore used to
   fail the BUILD on any host that has no runtime secrets — Vercel build
   containers never see .env.local. The check below is skipped during the build
   phase so the build is hermetic, and still fires loudly at runtime.

   `db` is a real Drizzle instance, not a lazy Proxy: @auth/drizzle-adapter
   detects the dialect with `is(db, PgDatabase)`, which walks the prototype
   chain looking for Drizzle's `entityKind` symbol. A Proxy fails that test
   with "Unsupported database type (object)". Note that `postgres()` does not
   open a socket until the first query, so constructing it here connects to
   nothing at import time. */

const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

const connectionString = process.env.DATABASE_URL;

if (!connectionString && !isBuildPhase) {
  throw new Error(
    "DATABASE_URL is not set — add it to .env.local locally, or to the project's environment variables when deployed",
  );
}

/* During a build with no secrets there is nothing to connect to; a harmless
   placeholder keeps the instance valid without ever being dialled. */
const url = connectionString ?? "postgres://localhost:5432/postgres";

const globalForDb = globalThis as unknown as { conn?: postgres.Sql };

const conn = globalForDb.conn ?? postgres(url, { prepare: false });
if (process.env.NODE_ENV !== "production") globalForDb.conn = conn;

export const db = drizzle(conn, { schema });

/** Cheap liveness probe for health checks / startup self-tests. */
export async function pingDb(): Promise<void> {
  await db.execute(sql`select 1`);
}
