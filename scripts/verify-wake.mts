/* Proof that the sweep notices waiting work — and never wakes a runner twice.

   The sweep exists to restore *attention*: when a dispatch is lost or a runner
   dies, the job is still in the queue, but nobody is looking at it. So the two
   ways this can be wrong are:

     · It wakes nothing when work is waiting. Then the backstop is decoration,
       and a stranded run stays stranded.
     · It wakes a runner when one is already awake or pending. Then every sweep
       buys another container and another `npm ci` to claim nothing, and on a
       paid plan that is real money.

   It also has to keep working when GitHub is unreachable, because "the API call
   failed" must not become "therefore wake another runner".

     npx tsx scripts/verify-wake.mts

   Everything it creates belongs to throwaway runs that are deleted at the end.
   No existing data is touched. */

import { config } from "dotenv";
import { count, desc, eq, inArray, sql as raw } from "drizzle-orm";

config({ path: ".env.local", quiet: true });

const { db, client } = await import("../lib/db");
const { runs, jobs, users } = await import("../lib/schema");
const { enqueue } = await import("../lib/queue");
const { sweepAndWake } = await import("../lib/platform/wake");
const { runnerConfigured } = await import("../lib/platform/runner");

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  PASS  ${label}${detail ? " — " + detail : ""}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
  }
}

const REAL_REPO = process.env.RUNNER_REPO?.trim() ?? "";

/* A repo that does not exist: the runs API answers 404, the way an outage or a
   revoked token would, so `runnerWorkflowRunsInFlight` returns null and the
   sweep has to decide from the database alone. */
const UNREACHABLE = "AYTechOfficial/this-repo-does-not-exist";

async function makeRun(label: string): Promise<string> {
  const [owner] = await db
    .select({ id: users.id, plan: users.plan })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(1);

  const [{ n }] = (await db.execute(
    raw`select count(*)::int as n from lastmile.runs where user_id = ${owner.id}`,
  )) as unknown as { n: number }[];

  const [run] = await db
    .insert(runs)
    .values({
      userId: owner.id,
      runNumber: n + 1,
      sentence: `${label} — safe to delete`,
      title: label,
      slug: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`,
      status: "queued",
      currentStage: "research",
      planId: owner.plan,
      startedAt: new Date(),
    })
    .returning({ id: runs.id });

  return run.id;
}

async function jobState(id: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return row;
}

/** Cancel the runner we deliberately woke, and wait for GitHub to finish with
    it. A row must never be deleted while a live runner could still be writing
    to it — the runner would then log an event against a run that no longer
    exists and die on a foreign key instead of exiting cleanly. */
async function cancelWokenRunner(): Promise<string> {
  const token = (process.env.RUNNER_TOKEN ?? process.env.GITHUB_TOKEN ?? "").trim();
  if (!REAL_REPO || !token) return "no runner configured, nothing to cancel";

  const H = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "lastmile-verify",
  };

  try {
    const list = await fetch(
      `https://api.github.com/repos/${REAL_REPO}/actions/workflows/${process.env.RUNNER_WORKFLOW?.trim() || "runner.yml"}/runs?per_page=5`,
      { headers: H, signal: AbortSignal.timeout(8_000) },
    );
    if (!list.ok) return `could not list runs (HTTP ${list.status})`;

    const data = (await list.json()) as { workflow_runs?: { id: number; status: string }[] };
    const busy = (data.workflow_runs ?? []).find((r) =>
      ["queued", "in_progress", "requested", "waiting", "pending"].includes(r.status),
    );
    if (!busy) return "the woken runner had already finished";

    await fetch(`https://api.github.com/repos/${REAL_REPO}/actions/runs/${busy.id}/cancel`, {
      method: "POST",
      headers: H,
      signal: AbortSignal.timeout(8_000),
    });

    /* Poll until it stops being busy, so cleanup happens strictly after it. */
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      const one = await fetch(`https://api.github.com/repos/${REAL_REPO}/actions/runs/${busy.id}`, {
        headers: H,
        signal: AbortSignal.timeout(8_000),
      });
      if (!one.ok) break;
      const state = (await one.json()) as { status: string };
      if (!["queued", "in_progress", "requested", "waiting", "pending"].includes(state.status)) {
        return `cancelled run ${busy.id} (now ${state.status})`;
      }
    }
    return `run ${busy.id} did not settle in time`;
  } catch (error) {
    return `cancel failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const created: string[] = [];
let dispatchedJobId: string | null = null;

try {
  console.log(`runner configured: ${runnerConfigured()} (repo ${REAL_REPO || "none"})`);

  /* ── 1. an empty queue must not buy a container ────────────────────────── */
  console.log("\n1. empty queue");
  const idle = await sweepAndWake();
  check("nothing claimed as waiting", idle.claimable === 0, `claimable=${idle.claimable}`);
  check("no runner woken", idle.dispatched === false);
  check("says why", idle.reason.includes("nothing queued"), idle.reason);

  /* ── 2. waiting work with nobody awake must wake a runner ──────────────── */
  console.log("\n2. work waiting, nobody awake");
  const runA = await makeRun("Wake sweep A");
  created.push(runA);
  const jobA = await enqueue({ runId: runA, kind: "research" });
  dispatchedJobId = jobA.id;

  const woke = await sweepAndWake();
  check("sees the waiting job", woke.claimable >= 1, `claimable=${woke.claimable}`);
  check("wakes a runner", woke.dispatched === true, woke.reason);
  check("claims to have woken one", woke.reason.includes("woke one"), woke.reason);

  /* ── 3. the same sweep again must not wake a second one ────────────────── */
  console.log("\n3. called again immediately (the idempotency guard)");
  /* Give GitHub a moment to register the workflow run it just accepted. The
     guard is exactly the code that has to cover that gap, so the test must not
     pass merely because the run had not appeared yet. */
  await new Promise((r) => setTimeout(r, 6_000));
  const again = await sweepAndWake();
  check("does not wake a second runner", again.dispatched === false, again.reason);
  check(
    "sees the first one as awake or pending",
    again.runsInFlight !== null && again.runsInFlight > 0,
    `runsInFlight=${again.runsInFlight}`,
  );

  /* ── 4. GitHub unreachable: fall back to the database, do not pile on ──── */
  console.log("\n4. GitHub unreachable (deciding from leases alone)");
  const runB = await makeRun("Wake sweep B");
  created.push(runB);
  const jobHeld = await enqueue({ runId: runB, kind: "research" });
  await enqueue({ runId: runB, kind: "prompt" });

  /* Take a lease by hand, as a local worker would. */
  await db.execute(raw`
    update lastmile.jobs
       set status = 'running', claimed_by = 'verify-wake', claimed_at = now(),
           heartbeat_at = now(), attempts = attempts + 1
     where id = ${jobHeld.id}
  `);

  process.env.RUNNER_REPO = UNREACHABLE;
  const blind = await sweepAndWake();
  check("cannot ask GitHub", blind.runsInFlight === null);
  check("does not wake a runner on a guess", blind.dispatched === false);
  check("from the live lease", blind.liveRunners >= 1, `liveRunners=${blind.liveRunners}`);
  check("and says the database decided", blind.reason.includes("unreachable"), blind.reason);

  /* ── 5. a lease that expired is handed back to the queue ──────────────── */
  console.log("\n5. a dead runner's lease is reclaimed by the sweep");
  await db.execute(raw`
    update lastmile.jobs
       set heartbeat_at = now() - interval '2 hours'
     where id = ${jobHeld.id}
  `);

  const swept = await sweepAndWake();
  check("reclaims the expired lease", swept.reclaimed === 1, `reclaimed=${swept.reclaimed}`);
  const reclaimedJob = await jobState(jobHeld.id);
  check("the job is queued again", reclaimedJob?.status === "queued", reclaimedJob?.status ?? "missing");
  check(
    "with the reason recorded",
    (reclaimedJob?.error ?? "").includes("lease expired"),
    reclaimedJob?.error ?? "(no error)",
  );
  check("still does not wake a runner while unreachable", swept.dispatched === false);

  process.env.RUNNER_REPO = REAL_REPO;
} finally {
  /* Cancel the runner we woke before touching rows it could still be writing. */
  const cancelled = await cancelWokenRunner();
  console.log(`\ncleanup: ${cancelled}`);

  for (const id of created) {
    await db.delete(runs).where(eq(runs.id, id));
  }

  const [{ n: leftovers }] = await db
    .select({ n: count() })
    .from(jobs)
    .where(created.length ? inArray(jobs.runId, created) : raw`false`);
  const [{ n: live }] = (await db.execute(
    raw`select count(*)::int as n from lastmile.jobs where status = 'running'`,
  )) as unknown as { n: number }[];

  console.log(
    `cleanup: ${created.length} probe run(s) deleted, ${Number(leftovers)} job(s) left behind, ${live} job(s) still leased`,
  );
  if (dispatchedJobId) console.log(`cleanup: the woken runner was called for job ${dispatchedJobId}`);

  await client.end();
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
