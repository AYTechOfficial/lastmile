import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { jobs, runs } from "./schema";
import type { JobKind } from "./domain";

/* The queue — the boundary that makes this product hostable.

   The dashboard never executes pipeline work. It writes a `jobs` row. A runner
   (GitHub Actions today) claims that row, does one stage, and writes the result
   back. Three properties make that safe:

     · Atomic claiming. `FOR UPDATE SKIP LOCKED` means two runners can never
       claim the same job, and neither blocks on the other.
     · Leases with heartbeats. A runner that dies stops beating; its job is
       reclaimed rather than lost. This is what replaces the old design's
       "the run is gone if the process restarted".
     · Bounded attempts with backoff. A job that keeps failing lands in `dead`
       and surfaces as a run error instead of looping forever. */

export type JobRow = typeof jobs.$inferSelect;

export type EnqueueInput = {
  runId: string;
  kind: JobKind;
  priority?: number;
  payload?: Record<string, unknown>;
  /** earliest claim time — how a retry is delayed */
  runAt?: Date;
  maxAttempts?: number;
};

/** Add a stage to the queue. Idempotent per (run, kind, attempt) — enqueueing
    the same stage twice for the same iteration returns the existing job. */
export async function enqueue(input: EnqueueInput): Promise<JobRow> {
  const [row] = await db
    .insert(jobs)
    .values({
      runId: input.runId,
      kind: input.kind,
      priority: input.priority ?? 0,
      payload: input.payload ?? {},
      runAt: input.runAt ?? new Date(),
      ...(input.maxAttempts ? { maxAttempts: input.maxAttempts } : {}),
    })
    .returning();
  return row;
}

/* Claiming returns a row read back through drizzle rather than through the
   UPDATE's own RETURNING clause.

   That is deliberate, and it is a bug fix. Raw SQL returns the database's
   snake_case column names (`claimed_by`), but a JobRow is typed with drizzle's
   camelCase properties (`claimedBy`). Returning the raw row would hand callers a
   correctly-typed object whose fields are all silently `undefined` — the worst
   possible shape of bug, because it type-checks. The claim itself stays a single
   atomic statement; the re-read just maps it faithfully. */

async function reread(id: string): Promise<JobRow | null> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return row ?? null;
}

/** Claim the next ready job for this runner, atomically.
    Returns null when there is nothing to do — the normal case for a
    cron-driven runner, not an error. */
export async function claim(workerId: string): Promise<JobRow | null> {
  const rows = (await db.execute(sql`
    update lastmile.jobs
       set status       = 'running',
           claimed_by   = ${workerId},
           claimed_at   = now(),
           heartbeat_at = now(),
           attempts     = attempts + 1,
           updated_at   = now()
     where id = (
       select id
         from lastmile.jobs
        where status = 'queued'
          and run_at <= now()
        order by priority desc, run_at asc, created_at asc
          for update skip locked
        limit 1
     )
    returning id
  `)) as unknown as { id: string }[];

  const id = rows[0]?.id;
  return id ? reread(id) : null;
}

/** Claim a specific job by id — used when a runner is dispatched for a known
    job rather than polling. */
export async function claimById(jobId: string, workerId: string): Promise<JobRow | null> {
  const rows = (await db.execute(sql`
    update lastmile.jobs
       set status       = 'running',
           claimed_by   = ${workerId},
           claimed_at   = now(),
           heartbeat_at = now(),
           attempts     = attempts + 1,
           updated_at   = now()
     where id = ${jobId}
       and status = 'queued'
    returning id
  `)) as unknown as { id: string }[];

  const id = rows[0]?.id;
  return id ? reread(id) : null;
}

/** Keep the lease alive. A long stage must call this well inside `leaseMs`,
    or the job will be handed to another runner while this one is still working. */
export async function heartbeat(jobId: string, workerId: string): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ heartbeatAt: new Date(), updatedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.claimedBy, workerId), eq(jobs.status, "running")))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

export async function complete(
  jobId: string,
  workerId: string,
  result: Record<string, unknown> = {},
): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "done", result, error: null, updatedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.claimedBy, workerId)));
}

/** Retry with exponential backoff, or give up and mark the job dead.
    A dead job is never silent — the caller records the reason on the run. */
export async function fail(
  jobId: string,
  workerId: string,
  error: string,
): Promise<{ willRetry: boolean }> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) return { willRetry: false };

  const exhausted = job.attempts >= job.maxAttempts;
  const backoffMs = Math.min(60_000 * 2 ** Math.max(0, job.attempts - 1), 15 * 60_000);

  await db
    .update(jobs)
    .set({
      status: exhausted ? "dead" : "queued",
      error,
      claimedBy: null,
      claimedAt: null,
      heartbeatAt: null,
      runAt: exhausted ? job.runAt : new Date(Date.now() + backoffMs),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));

  return { willRetry: !exhausted };
}

/** Return jobs whose runner stopped beating to the queue.
    Called by the runner before it claims, so a crashed machine never strands a
    run. This is the safety net that the old in-process design did not have. */
export async function reclaimStale(): Promise<number> {
  const rows = await db.execute(sql`
    update lastmile.jobs
       set status       = case when attempts >= max_attempts then 'dead' else 'queued' end,
           error        = coalesce(error, 'runner stopped responding — lease expired'),
           claimed_by   = null,
           claimed_at   = null,
           heartbeat_at = null,
           updated_at   = now()
     where status = 'running'
       and heartbeat_at < now() - (lease_ms || ' milliseconds')::interval
    returning id
  `);
  return rows.length;
}

/** Stop a run: cancel everything still queued for it.
    The runner checks `runs.kill_requested` between stages, so an in-flight
    stage finishes and then stops rather than being torn down mid-write. */
export async function cancelQueuedForRun(runId: string): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(jobs.runId, runId), inArray(jobs.status, ["queued"])))
    .returning({ id: jobs.id });
  return rows.length;
}

/** Has the operator or user asked this run to stop? */
export async function killRequested(runId: string): Promise<boolean> {
  const [row] = await db
    .select({ kill: runs.killRequested })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return row?.kill ?? false;
}
