/* Reading a run for the dashboard.

   Deliberately database-only: this module imports the schema and nothing else.
   That restriction is the bug fix. The previous build's run page reached the
   agent pipeline through this file — `getRunState` called `advanceRun`, which
   imported the orchestrator, which imported the tester, which imported a
   browser driver — and the run page died on a host that could not resolve it.

   The other half of the fix is what this file does NOT do: it does not
   reconcile state. In the previous design, *reading* a run advanced it, so a
   page refresh could restart work. Now the queue is the only writer that
   advances a run: the runner claims a job, does the stage, writes the result.
   The dashboard reports what those rows say, and if they say a stage failed,
   that is what the user sees. */

import { and, asc, eq } from "drizzle-orm";
import { db } from "./db";
import { agentRuns, runEvents, runFlows, runIssues, runs } from "./schema";

/** Everything the run view renders, for one run owned by one user.
    Returns null when the run does not exist *or* belongs to someone else —
    an id the caller may not read must be indistinguishable from no id at all. */
export async function getRunState(runId: string, userId: string) {
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, userId)))
    .limit(1);

  if (!run) return null;

  const [events, flows, agents, issues] = await Promise.all([
    db.select().from(runEvents).where(eq(runEvents.runId, run.id)).orderBy(asc(runEvents.seq)),
    db.select().from(runFlows).where(eq(runFlows.runId, run.id)).orderBy(asc(runFlows.position)),
    db.select().from(agentRuns).where(eq(agentRuns.runId, run.id)).orderBy(asc(agentRuns.startedAt)),
    db.select().from(runIssues).where(eq(runIssues.runId, run.id)).orderBy(asc(runIssues.createdAt)),
  ]);

  return { run, events, flows, agents, issues };
}
