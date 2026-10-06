import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/* The one database client. Both the dashboard (serverless) and the runner
   (ephemeral CI machine) import this, so the settings have to suit both.

   Two things here are deliberate and were learned the hard way:

   1. `prepare: false` — Supabase's transaction pooler (port 6543) multiplexes
      connections across backends, so server-side prepared statements cannot be
      relied on. Without this, statements intermittently fail to resolve.

   2. A small pool. A serverless platform runs many isolated instances, each of
      which would otherwise open its own pool and exhaust the database's
      connection limit. One connection per instance is the right number, and
      idle connections are released quickly so a scaled-to-zero deployment does
      not hold the pooler open. */

const url = process.env.DATABASE_URL?.trim();

/* `next build` has no database and does not need one. Asserting here used to
   make production builds fail in environments that were intentionally not
   wired to the database — a build should be hermetic. */
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

if (!url && !isBuildPhase) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.",
  );
}

const connectionString = url ?? "postgres://unused:unused@127.0.0.1:5432/unused";

const poolMax = Number(process.env.PG_POOL_MAX ?? (isBuildPhase ? 1 : 5));

export const client = postgres(connectionString, {
  max: poolMax,
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  connect_timeout: 10,
  prepare: false,
  onnotice: () => {},
});

export const db = drizzle(client, { schema });

export type Db = typeof db;
