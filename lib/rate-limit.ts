import { sql } from "drizzle-orm";
import { db } from "./db";

/* A rate limiter that survives a serverless deployment.

   In-memory counters are useless here: each request may land on a different
   instance, so a limit enforced in one process is not a limit. This keeps the
   counts in Postgres, in one small table, written with a single upsert.

   It is deliberately best-effort. If the database is unreachable the call
   allows the request rather than locking users out — a limiter should not be
   the thing that takes the product down. */

export type RateLimitResult = { ok: boolean; remaining: number };

/* Created lazily rather than by a migration so the limiter works on a fresh
   database without a deploy step. */
let ensured = false;

async function ensureTable(): Promise<void> {
  if (ensured) return;
  await db.execute(sql`
    create table if not exists lastmile.rate_limits (
      key         text primary key,
      count       integer not null default 0,
      window_start timestamptz not null default now()
    )
  `);
  ensured = true;
}

export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  try {
    await ensureTable();

    const rows = await db.execute(sql`
      insert into lastmile.rate_limits (key, count, window_start)
      values (${key}, 1, now())
      on conflict (key) do update
         set count = case
                       when lastmile.rate_limits.window_start < now() - (${windowMs} || ' milliseconds')::interval
                       then 1
                       else lastmile.rate_limits.count + 1
                     end,
             window_start = case
                       when lastmile.rate_limits.window_start < now() - (${windowMs} || ' milliseconds')::interval
                       then now()
                       else lastmile.rate_limits.window_start
                     end
      returning count
    `);

    const count = Number((rows[0] as { count?: number } | undefined)?.count ?? 1);
    return { ok: count <= limit, remaining: Math.max(0, limit - count) };
  } catch {
    /* Fail open, deliberately. */
    return { ok: true, remaining: limit };
  }
}
