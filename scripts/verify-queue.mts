/* Proof that the queue actually works.

   This exercises the real `lib/queue.ts` functions against the real database —
   not a re-implementation — because the failure this codebase exists to prevent
   was precisely a queue that looked correct and never ran.

     npx tsx scripts/verify-queue.ts

   What it establishes:

     1. A job can be enqueued and claimed exactly once.
     2. Two workers claiming concurrently never receive the same job.
     3. A runner that dies (stops heartbeating) loses its lease and the job is
        reclaimed — the property that makes a crash survivable.
     4. A failed job backs off, retries, and eventually goes dead rather than
        looping forever.
     5. The event log appends contiguously even under concurrent writers.

   Everything it creates belongs to one throwaway run, which is deleted at the
   end. No existing data is touched. */

import { config } from "dotenv";
import { eq, sql as raw } from "drizzle-orm";

config({ path: ".env.local", quiet: true });

const { db } = await import("../lib/db");
const { runs } = await import("../lib/schema");
const {
  enqueue,
  claim,
  heartbeat,
  complete,
  fail,
  reclaimStale,
  cancelQueuedForRun,
  killRequested,
} = await import("../lib/queue");
const { logEvent, readEvents } = await import("../lib/events");

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${label}${detail ? " — " + detail : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
  }
}

const [{ id: userId }] = (await db.execute(
  raw`select id from lastmile."user" order by created_at limit 1`,
)) as unknown as { id: string }[];

if (!userId) {
  console.error("No user in lastmile.user — run `node scripts/db-seed.mjs` first.");
  process.exit(1);
}

const [{ n: runCount }] = (await db.execute(
  raw`select count(*)::int as n from lastmile.runs where user_id = ${userId}`,
)) as unknown as { n: number }[];

const [run] = await db
  .insert(runs)
  .values({
    userId,
    runNumber: runCount + 1,
    sentence: "queue verification run — safe to delete",
    title: "Queue verification",
    slug: "queue-verification",
    status: "queued",
    currentStage: "research",
    planId: "free",
    startedAt: new Date(),
  })
  .returning();

console.log(`\ntest run ${run.id} (run #${run.runNumber})\n`);

try {
  /* ── 1. enqueue and claim exactly once ─────────────────────────────────── */
  console.log("1. enqueue + claim");
  const job = await enqueue({ runId: run.id, kind: "research" });
  check("enqueued as queued", job.status === "queued");

  const claimed = await claim("worker-A");
  check("claim returns the job", claimed?.id === job.id);
  check("status is running", claimed?.status === "running");
  check("attempts incremented to 1", claimed?.attempts === 1);
  check("claimed_by recorded", claimed?.claimedBy === "worker-A");

  const nothing = await claim("worker-B");
  check("a second worker does not steal a running job", nothing === null);

  /* ── 2. concurrent claiming never double-assigns ───────────────────────── */
  console.log("\n2. concurrent claim (the SKIP LOCKED guarantee)");
  for (let i = 0; i < 6; i++) {
    await enqueue({ runId: run.id, kind: "test", payload: { seq: i } });
  }
  const pairs = await Promise.all([
    claim("worker-C"),
    claim("worker-D"),
    claim("worker-E"),
    claim("worker-F"),
    claim("worker-G"),
    claim("worker-H"),
  ]);
  const ids = pairs.filter(Boolean).map((j) => j!.id);
  check("six claims returned six jobs", ids.length === 6, `${ids.length} returned`);
  check("no job was handed out twice", new Set(ids).size === ids.length);
  check("each is owned by a distinct worker", new Set(pairs.map((p) => p!.claimedBy)).size === 6);

  /* ── 3. a dead runner's lease is reclaimed ─────────────────────────────── */
  console.log("\n3. lease expiry after a runner dies");
  const victim = claimed!;
  /* Simulate a runner that stopped beating 30 minutes ago: the lease is 15. */
  await db.execute(
    raw`update lastmile.jobs set heartbeat_at = now() - interval '30 minutes'
         where id = ${victim.id}`,
  );
  const reclaimed = await reclaimStale();
  check("reclaim swept at least one job", reclaimed >= 1, `${reclaimed} reclaimed`);

  const [after] = (await db.execute(
    raw`select status, claimed_by, error from lastmile.jobs where id = ${victim.id}`,
  )) as unknown as { status: string; claimed_by: string | null; error: string | null }[];
  check("job returned to queued", after.status === "queued");
  check("lease holder cleared", after.claimed_by === null);
  check("reason recorded", Boolean(after.error));

  /* ── 4. heartbeat keeps a lease alive ──────────────────────────────────── */
  console.log("\n4. heartbeat");
  const re = await claim("worker-A");
  check("reclaimed job can be claimed again", re?.id === victim.id);
  check("attempts incremented again", re?.attempts === 2);
  check("heartbeat accepted from the holder", (await heartbeat(re!.id, "worker-A")) === true);
  check("heartbeat rejected from a stranger", (await heartbeat(re!.id, "worker-Z")) === false);

  /* ── 5. failure backs off, then goes dead ──────────────────────────────── */
  console.log("\n5. failure, backoff, and the dead end");
  const first = await fail(re!.id, "worker-A", "simulated stage failure");
  check("first failure schedules a retry", first.willRetry === true);

  const [backedOff] = (await db.execute(
    raw`select status, run_at > now() as future from lastmile.jobs where id = ${re!.id}`,
  )) as unknown as { status: string; future: boolean }[];
  check("status is queued again", backedOff.status === "queued");
  check("retry is delayed, not immediate", backedOff.future === true);

  /* Exhaust the attempts to prove a permanently broken job stops. */
  await db.execute(
    raw`update lastmile.jobs set attempts = max_attempts, run_at = now()
         where id = ${re!.id}`,
  );
  const exhausted = await fail(re!.id, "worker-A", "still broken");
  check("retry refused once attempts are spent", exhausted.willRetry === false);

  const [dead] = (await db.execute(
    raw`select status from lastmile.jobs where id = ${re!.id}`,
  )) as unknown as { status: string }[];
  check("job is dead, not looping", dead.status === "dead");

  /* ── 6. completion ─────────────────────────────────────────────────────── */
  console.log("\n6. completion");
  /* Everything from step 2 is still held by its worker, and the step-5 job is
     dead, so completion needs a job of its own. */
  await enqueue({ runId: run.id, kind: "prompt" });
  const finisher = await claim("worker-A");
  check("a fresh job is claimable", finisher !== null);
  await complete(finisher!.id, "worker-A", { ok: true });
  const [done] = (await db.execute(
    raw`select status, result from lastmile.jobs where id = ${finisher!.id}`,
  )) as unknown as { status: string; result: unknown }[];
  check("status is done", done.status === "done");
  check("result persisted", Boolean(done.result));

  /* ── 7. cancellation for a stopped run ─────────────────────────────────── */
  console.log("\n7. stopping a run");
  await enqueue({ runId: run.id, kind: "code" });
  await enqueue({ runId: run.id, kind: "deploy" });
  const cancelled = await cancelQueuedForRun(run.id);
  check("queued work cancelled", cancelled >= 2, `${cancelled} cancelled`);
  check("kill flag reads back", (await killRequested(run.id)) === false);

  /* ── 8. concurrent event appends stay contiguous ───────────────────────── */
  console.log("\n8. event log under concurrent writers");
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      logEvent(run.id, "verify", "info", `concurrent line ${i}`),
    ),
  );
  const events = await readEvents(run.id);
  const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
  check("all eight lines written", events.length >= 8, `${events.length} rows`);
  check(
    "sequence numbers are contiguous with no gaps or duplicates",
    new Set(seqs).size === seqs.length && seqs.every((s, i) => s === i + 1),
    seqs.join(","),
  );
} finally {
  /* Remove the throwaway run and everything that cascades from it. */
  await db.delete(runs).where(eq(runs.id, run.id));
  const [{ n: leftovers }] = (await db.execute(
    raw`select count(*)::int as n from lastmile.jobs where run_id = ${run.id}`,
  )) as unknown as { n: number }[];
  console.log(`\ncleanup: test run deleted, ${leftovers} jobs left behind`);

  const { client } = await import("../lib/db");
  await client.end();
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
