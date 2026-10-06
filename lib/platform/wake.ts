/* Noticing that work is waiting, and nobody is awake to do it.

   Every path that queues a stage already asks GitHub to start a runner. This is
   the backstop for the times that ask does not arrive or does not stick:

     · the dispatch call failed (network, API hiccup) and the job was never heard
     · a runner was killed mid-stage, so its lease expired and the job went back
       to `queued` with nobody left to pick it up
     · GitHub's own `schedule` trigger, which is documented as best-effort, did
       not fire for tens of minutes

   The queue is the source of truth, so none of those lose work — the job is still
   sitting there. What they lose is *attention*. This function restores it.

   Two rules keep it cheap and idempotent:

     · It never dispatches when the queue has nothing claimable. Waking a runner
       for an empty queue buys a container, an `npm ci`, and a no-op.
     · It never dispatches when a runner is already awake or pending. That is
       asked of GitHub rather than guessed from the database, because a dispatched
       workflow run can be queued without holding any lease yet — exactly the
       window in which a second sweep would double-dispatch.

   Deliberately NOT a scheduler. Something still has to call this on a timer
   (Supabase Cron today, the run page's live poll as well once it exists). */

import { sql } from "drizzle-orm";
import { db } from "../db";
import { reclaimStale } from "../queue";
import { dispatchRunner, runnerConfigured, runnerWorkflowRunsInFlight } from "./runner";

export type SweepResult = {
  /** jobs handed back to the queue because their runner stopped beating */
  reclaimed: number;
  /** jobs that could be claimed right now */
  claimable: number;
  /** jobs whose lease is still alive — a runner is mid-stage on them */
  liveRunners: number;
  /** runner workflow runs GitHub considers queued or running.
      `null` means we did not ask, or could not — see `reason`. */
  runsInFlight: number | null;
  dispatched: boolean;
  /** what this sweep decided and why, in words, for logs and the run page */
  reason: string;
};

export async function sweepAndWake(): Promise<SweepResult> {
  /* First, take the leases away from runners that are gone. Doing this before
     counting is what turns a dead runner's job back into visible work. */
  const reclaimed = await reclaimStale();

  const [counts] = (await db.execute(sql`
    select
      count(*) filter (
        where status = 'queued' and run_at <= now()
      )::int as claimable,
      count(*) filter (
        where status = 'running'
          and heartbeat_at >= now() - (lease_ms || ' milliseconds')::interval
      )::int as live
      from lastmile.jobs
  `)) as unknown as { claimable: number; live: number }[];

  const claimable = Number(counts?.claimable ?? 0);
  const liveRunners = Number(counts?.live ?? 0);

  if (claimable === 0) {
    return {
      reclaimed,
      claimable,
      liveRunners,
      runsInFlight: null,
      dispatched: false,
      reason: "nothing queued — no runner needed",
    };
  }

  if (!runnerConfigured()) {
    return {
      reclaimed,
      claimable,
      liveRunners,
      runsInFlight: null,
      dispatched: false,
      reason: `${claimable} job(s) waiting, but no runner is configured — run it locally with \`npx tsx runner/index.mts\``,
    };
  }

  const inFlight = await runnerWorkflowRunsInFlight();

  /* When GitHub cannot be reached, fall back to the database's own view: a
     running job with a live lease means somebody is working. Weaker evidence,
     which is why it is only the fallback. */
  const runnerIsAwake = inFlight === null ? liveRunners > 0 : inFlight > 0;

  if (runnerIsAwake) {
    return {
      reclaimed,
      claimable,
      liveRunners,
      runsInFlight: inFlight,
      dispatched: false,
      reason:
        inFlight === null
          ? `${claimable} job(s) waiting; a runner holds a live lease (GitHub unreachable, so the database decided this)`
          : `${claimable} job(s) waiting; ${inFlight} runner run(s) already awake or pending`,
    };
  }

  const dispatched = await dispatchRunner();

  return {
    reclaimed,
    claimable,
    liveRunners,
    runsInFlight: inFlight,
    dispatched,
    reason: dispatched
      ? `${claimable} job(s) waiting and no runner awake — woke one`
      : `${claimable} job(s) waiting; the dispatch failed and the next sweep will retry`,
  };
}
