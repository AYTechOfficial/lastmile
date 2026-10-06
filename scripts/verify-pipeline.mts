/* Verify the stage machine and the runner's job lifecycle.

     npx tsx scripts/verify-pipeline.mts

   Two parts:

     1. `advance()` is a pure function of (stage, outcome, plan, iteration), so
        it can be checked exhaustively — including every way the quality loop is
        allowed to end. A loop that cannot terminate is the classic way an agent
        pipeline burns a budget overnight.

     2. The runner BINARY is executed for real, against the real database, and
        its durable behaviour is asserted: a claimed job increments its attempt
        count, a failing stage schedules a retry without falsely telling the user
        the run failed, and only exhausting the attempts ends the run.

   Nothing here fabricates pipeline output. The stage under test deliberately has
   no executor yet, which is exactly the state the runner must handle honestly. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "dotenv";
import { eq, sql as raw } from "drizzle-orm";

config({ path: ".env.local", quiet: true });

const run = promisify(execFile);

const { db, client } = await import("../lib/db");
const { runs, jobs, runEvents, agentRuns } = await import("../lib/schema");
const { advance, filesToRepatch } = await import("../lib/pipeline/state");
const { enqueue } = await import("../lib/queue");
const { PLANS } = await import("../lib/plans");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${label}${detail ? " — " + detail : ""}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
  }
}

const plan = PLANS.free;
const clean = { ok: true, issues: 0, blocking: 0 };
const broken = { ok: true, issues: 2, blocking: 2 };

/* ── 1. the stage machine, exhaustively ──────────────────────────────────── */
console.log("\n1. the stage machine");

check("research hands off to the prompt agent", advance("research", clean, plan, 1).type === "enqueue");
check(
  "and specifically to prompt",
  JSON.stringify(advance("research", clean, plan, 1)) === JSON.stringify({ type: "enqueue", kind: "prompt", iteration: 1 }),
);
check(
  "the master prompt parks the run at the human checkpoint",
  advance("prompt", clean, plan, 1).type === "await_approval",
);
check("code hands off to verify", (advance("code", clean, plan, 1) as { kind?: string }).kind === "verify");
check("a clean verify hands off to deploy", (advance("verify", clean, plan, 1) as { kind?: string }).kind === "deploy");
check("deploy hands off to live QA", (advance("deploy", clean, plan, 1) as { kind?: string }).kind === "test");
check("a clean live QA finishes the run", advance("test", clean, plan, 1).type === "finish");

/* The loop must be able to end, and must be able to keep going — both matter. */
const verifyFix = advance("verify", broken, plan, 1) as { type: string; kind?: string; iteration?: number; payload?: Record<string, unknown> };
check("blocking defects send the run back to code", verifyFix.type === "enqueue" && verifyFix.kind === "code");
check("on the next iteration", verifyFix.iteration === 2);
check("flagged as a fix round, not a first pass", verifyFix.payload?.fixOnly === true);

const testFix = advance("test", broken, plan, 2) as { type: string; kind?: string; iteration?: number };
check("live QA failures also loop back to code", testFix.type === "enqueue" && testFix.kind === "code", `iteration ${testFix.iteration}`);

check(
  "the loop terminates at the plan budget (verify)",
  advance("verify", broken, plan, plan.maxIterations).type === "finish",
);
check(
  "the loop terminates at the plan budget (test)",
  advance("test", broken, plan, plan.maxIterations).type === "finish",
);

const capped = advance("verify", broken, plan, plan.maxIterations) as { reason?: string };
check("and says why it stopped", Boolean(capped.reason), capped.reason ?? "");

check("a failed stage fails the run rather than advancing", advance("code", { ok: false, issues: 0, blocking: 0, reason: "boom" }, plan, 1).type === "fail");
check("with the stage's own reason attached", (advance("code", { ok: false, issues: 0, blocking: 0, reason: "boom" }, plan, 1) as { reason?: string }).reason === "boom");

/* Pro has a bigger budget than free — the plan must actually change behaviour. */
check(
  "a pro plan gets more loop rounds than free",
  (advance("verify", broken, PLANS.pro, PLANS.free.maxIterations) as { type: string }).type === "enqueue",
);

/* ── 2. fix rounds are surgical ──────────────────────────────────────────── */
console.log("\n2. fix rounds touch only the named files");

const files = filesToRepatch([
  { id: "a", iteration: 1, source: "verify", severity: "major", title: "t", detail: null, files: ["app/page.tsx", "lib/x.ts"], status: "open" },
  { id: "b", iteration: 1, source: "verify", severity: "major", title: "t", detail: null, files: ["lib/x.ts"], status: "open" },
  { id: "c", iteration: 1, source: "verify", severity: "major", title: "t", detail: null, files: [], status: "open" },
]);
check("deduplicated", files.length === 2, files.join(", "));
check("and deterministic", JSON.stringify(files) === JSON.stringify([...files].sort()));

/* ── 3. the runner binary, for real ──────────────────────────────────────── */
console.log("\n3. the runner's job lifecycle");

const [{ id: userId }] = (await db.execute(
  raw`select id from lastmile."user" order by created_at limit 1`,
)) as unknown as { id: string }[];
const [{ n: runCount }] = (await db.execute(
  raw`select count(*)::int as n from lastmile.runs where user_id = ${userId}`,
)) as unknown as { n: number }[];

const [testRun] = await db
  .insert(runs)
  .values({
    userId,
    runNumber: runCount + 1,
    sentence: "runner verification run — safe to delete",
    title: "Runner verification",
    slug: "runner-verification",
    status: "queued",
    currentStage: "research",
    planId: "free",
    startedAt: new Date(),
  })
  .returning();

const researchJob = await enqueue({ runId: testRun.id, kind: "research" });

try {
  const { stdout } = await run("npx", ["tsx", "runner/index.mts", "--job", researchJob.id], {
    timeout: 120_000,
    shell: true,
  });
  console.log("    runner said:", stdout.trim().split("\n").slice(-1)[0]);

  const [afterFirst] = await db.select().from(jobs).where(eq(jobs.id, researchJob.id)).limit(1);
  check("the job was claimed and attempted", afterFirst.attempts === 1, `attempts=${afterFirst.attempts}`);
  check("a failure with attempts remaining is queued for retry", afterFirst.status === "queued", afterFirst.status);
  check("the retry is delayed rather than immediate", afterFirst.runAt.getTime() > Date.now());
  check("the failure reason is recorded on the job", Boolean(afterFirst.error), (afterFirst.error ?? "").slice(0, 60));

  const [afterRun] = await db.select().from(runs).where(eq(runs.id, testRun.id)).limit(1);
  check(
    "the run is NOT reported as failed while a retry is pending",
    afterRun.status === "running",
    afterRun.status,
  );

  const [{ n: errs }] = (await db.execute(
    raw`select count(*)::int as n from lastmile.run_events where run_id = ${testRun.id} and kind = 'error'`,
  )) as unknown as { n: number }[];
  check("the failure is visible in the run's feed", errs >= 1, `${errs} error event(s)`);

  const [agent] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.runId, testRun.id))
    .limit(1);
  check("an agent_runs row records the attempt", Boolean(agent), agent?.status ?? "none");
  check("and it is marked failed, not done", agent?.status === "failed", agent?.status ?? "");

  /* Exhaust the attempts: now the run really is finished, and says so. */
  await db
    .update(jobs)
    .set({ attempts: 3, runAt: new Date() })
    .where(eq(jobs.id, researchJob.id));

  await run("npx", ["tsx", "runner/index.mts", "--job", researchJob.id], { timeout: 120_000, shell: true });

  const [afterSecond] = await db.select().from(jobs).where(eq(jobs.id, researchJob.id)).limit(1);
  check("spent attempts move the job to dead", afterSecond.status === "dead", afterSecond.status);

  const [finalRun] = await db.select().from(runs).where(eq(runs.id, testRun.id)).limit(1);
  check("and now the run is failed", finalRun.status === "failed", finalRun.status);
  check("with a reason a user can act on", Boolean(finalRun.error), (finalRun.error ?? "").slice(0, 70));

  /* Nothing left to claim must be a clean no-op, not an error. */
  const idle = await run("npx", ["tsx", "runner/index.mts"], { timeout: 120_000, shell: true });
  check("an empty queue exits cleanly", idle.stdout.includes("no work available"));
} finally {
  await db.delete(runs).where(eq(runs.id, testRun.id));
  const [{ n: left }] = (await db.execute(
    raw`select count(*)::int as n from lastmile.jobs where run_id = ${testRun.id}`,
  )) as unknown as { n: number }[];
  console.log(`\ncleanup: test run deleted, ${left} jobs left behind`);
  void runEvents;
}

await client.end();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
