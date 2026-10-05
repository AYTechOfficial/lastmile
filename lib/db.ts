import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/* Supabase Postgres over the Supavisor session pooler (IPv4-safe on every
   host). prepare:false is required by the pooler. */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set — check .env.local");
}

const globalForDb = globalThis as unknown as { conn?: postgres.Sql };

const conn = globalForDb.conn ?? postgres(connectionString, { prepare: false });
if (process.env.NODE_ENV !== "production") globalForDb.conn = conn;

export const db = drizzle(conn, { schema });
