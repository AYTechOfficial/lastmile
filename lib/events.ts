import { asc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { runEvents } from "./schema";
import type { AgentEventKind } from "./domain";

/* The live feed — an append-only log the dashboard streams.

   `seq` is allocated per run, and the allocation is serialised with a
   transaction-scoped advisory lock keyed on the run id.

   This replaced a read-max-then-insert with a retry loop, and that version was
   wrong in a way worth recording: concurrent appends computed the same next
   value, collided on the unique (run_id, seq) index, and any writer that
   exhausted its retries dropped its line. Under eight concurrent writers the
   feed silently lost one line in roughly half of runs — telemetry quietly
   disappearing is far worse than telemetry arriving late.

   Now writers for a given run queue on the lock, each sees the true max, and the
   insert is exact. The critical section is a single insert, so contention is
   measured in microseconds, and locks are scoped to a run rather than the table,
   so unrelated runs never contend with each other. */

export async function logEvent(
  runId: string,
  stage: string,
  kind: AgentEventKind,
  line: string,
): Promise<void> {
  const at = new Date();

  try {
    await db.transaction(async (tx) => {
      /* hashtextextended gives a stable 64-bit key from the run id, and the lock
         is released automatically when this transaction ends. */
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${runId}, 0))`);

      await tx.execute(sql`
        insert into lastmile.run_events (run_id, seq, stage, kind, line, at)
        select ${runId}::uuid,
               coalesce(max(seq), 0) + 1,
               ${stage}, ${kind}, ${line}, ${at.toISOString()}::timestamptz
          from lastmile.run_events
         where run_id = ${runId}::uuid
      `);
    });
  } catch (error) {
    /* Telemetry must never break the pipeline: a run should not fail because a
       log line could not be written. But it must not be silent either — this is
       an error, not a debug detail. */
    console.error("RUN_EVENTS_APPEND_FAILED", { runId, stage, kind, line, error });
  }
}

/** The whole feed for a run, oldest first. The dashboard renders this directly. */
export async function readEvents(runId: string, limit = 2000) {
  return db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.seq))
    .limit(limit);
}
