/* The runner.

   Claims one job, runs its stage, and advances the pipeline. Everything durable
   lives here rather than in the stages: leases, heartbeats, retries, run status
   transitions and the next-stage decision.

     npx tsx runner/index.mts              # take the next queued job
     npx tsx runner/index.mts --job <id>   # take a specific job

   This process is disposable by design. It runs on an ephemeral CI machine, it
   holds no state that matters, and if it is killed mid-stage the lease expires
   and another runner picks the job up. That is the whole reason the previous
   in-process design could not survive. */

import { and, eq, sql } from "drizzle-orm";
import { config } from "dotenv";
/* Type-only imports are erased at build time, so they can sit above the runtime
   imports that must happen after the environment is loaded. */
import type { StageOutcome } from "../lib/pipeline/state";
import type { JobKind } from "../lib/domain";

config({ path: ".env.local", quiet: true });

const { db, client } = await import("../lib/db");
const { runs, agentRuns, jobs } = await import("../lib/schema");
const { claim, claimById, complete, fail, heartbeat, reclaimStale } = await import("../lib/queue");
const { logEvent } = await import("../lib/events");
/* The next-stage decision and the file-scoping helper live in state.ts; the
   issue ledger lives in issues.ts. */
const { advance, filesToRepatch } = await import("../lib/pipeline/state");
const { openIssues } = await import("../lib/pipeline/issues");
const { planOf } = await import("../lib/plans");
const { STAGE_EXECUTORS, hasExecutor } = await import("./stages");
const { dispatchRunner } = await import("../lib/platform/runner");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const workerId =
  process.env.WORKER_ID?.trim() || `local-${process.pid}-${Date.now()}`;

const requestedJob = argValue("--job");

async function main(): Promise<void> {
  /* Sweep before claiming: a runner that died without releasing its lease must
     not leave the job invisible forever. This is the safety net. */
  const reclaimed = await reclaimStale();
  if (reclaimed > 0) console.log(`reclaimed ${reclaimed} expired lease(s)`);

  const job = requestedJob ? await claimById(requestedJob, workerId) : await claim(workerId);

  if (!job) {
    console.log("no work available");
    return;
  }

  const kind = job.kind as JobKind;
  console.log(`claimed job ${job.id} (${kind}) attempt ${job.attempts}/${job.maxAttempts}`);

  const [run] = await db.select().from(runs).where(eq(runs.id, job.runId)).limit(1);
  if (!run) {
    /* The run was deleted between enqueue and claim; nothing to run. */
    await complete(job.id, workerId, { skipped: "run no longer exists" });
    return;
  }

  const plan = planOf(run.planId);
  const iteration = run.iterations + 1;

  if (run.killRequested) {
    console.log("run was stopped before the stage began");
    await complete(job.id, workerId, { cancelled: true });
    await db
      .update(runs)
      .set({ status: "stopped", completedAt: new Date() })
      .where(eq(runs.id, run.id));
    return;
  }

  /* The run is genuinely running now — which is a fact, not an assumption. */
  await db
    .update(runs)
    .set({ status: "running", currentStage: kind, error: null })
    .where(eq(runs.id, run.id));

  await db
    .insert(agentRuns)
    .values({
      runId: run.id,
      agent: kind,
      iteration,
      status: "running",
      startedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [agentRuns.runId, agentRuns.agent, agentRuns.iteration],
      set: { status: "running", startedAt: new Date(), error: null },
    });

  /* Keep the lease alive for the whole stage. A stage running longer than the
     lease without beating would be handed to a second runner mid-write. */
  const beat = setInterval(
    () => {
      void heartbeat(job.id, workerId).catch(() => {});
    },
    Math.max(5_000, Math.floor(job.leaseMs / 3)),
  );

  const startedAt = Date.now();
  let outcome: StageOutcome;

  try {
    if (!hasExecutor(kind)) {
      /* Truthful failure. Emitting plausible events here would make the
         dashboard show a working pipeline that is not doing anything. */
      throw new Error(
        `the ${kind} stage has no executor yet — it is still being built, so this run cannot continue`,
      );
    }

    const executor = STAGE_EXECUTORS[kind]!;
    outcome = await executor({
      run,
      plan,
      iteration,
      payload: (job.payload as Record<string, unknown>) ?? {},
      emit: (eventKind, line) => logEvent(run.id, kind, eventKind, line),
      heartbeat: async () => {
        await heartbeat(job.id, workerId);
      },
      liveUrl: run.liveUrl,
      repo: run.repoOwner && run.repoName ? { owner: run.repoOwner, name: run.repoName } : null,
      /* The owning user, so a stage resolves that user's own credentials rather
         than the platform's. */
      userId: run.userId,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    clearInterval(beat);

    await logEvent(run.id, kind, "error", `${kind} stage failed: ${reason}`);

    const { willRetry } = await fail(job.id, workerId, reason);

    await db
      .update(agentRuns)
      .set({ status: "failed", error: reason, elapsedMs: Date.now() - startedAt, endedAt: new Date() })
      .where(
        and(
          eq(agentRuns.runId, run.id),
          eq(agentRuns.agent, kind),
          eq(agentRuns.iteration, iteration),
        ),
      );

    /* Only a job that is out of attempts ends the run — a retry must not be
       reported to the user as a failure that already happened. */
    if (!willRetry) {
      await db
        .update(runs)
        .set({ status: "failed", error: reason, completedAt: new Date() })
        .where(eq(runs.id, run.id));
      await logEvent(run.id, "orchestrator", "error", `run failed: ${reason}`);
    } else {
      await logEvent(run.id, "orchestrator", "warn", `will retry (attempt ${job.attempts}/${job.maxAttempts})`);
    }
    return;
  }

  clearInterval(beat);

  /* Record what the stage found. */
  await db
    .update(agentRuns)
    .set({
      status: outcome.ok ? "done" : "failed",
      elapsedMs: Date.now() - startedAt,
      tokens: outcome.tokens ?? 0,
      endedAt: new Date(),
      error: outcome.ok ? null : (outcome.reason ?? null),
    })
    .where(
      and(eq(agentRuns.runId, run.id), eq(agentRuns.agent, kind), eq(agentRuns.iteration, iteration)),
    );

  if (outcome.tokens) {
    await db
      .update(runs)
      .set({ tokens: run.tokens + outcome.tokens })
      .where(eq(runs.id, run.id));

    /* Metering happens where the tokens are counted: the stage's usage is
       charged to the owner's credit balance at the operator's price, and the
       movement lands in the ledger. A metering failure never fails the stage. */
    try {
      const { chargeRunTokens } = await import("../lib/credits");
      const { chargedMilli, balanceMilli } = await chargeRunTokens(
        run.userId,
        run.id,
        outcome.tokens,
        `spend:${kind}`,
      );
      if (chargedMilli > 0) {
        console.log(`charged $${(chargedMilli / 1000).toFixed(3)} — balance $${(balanceMilli / 1000).toFixed(2)}`);
        await db
          .update(runs)
          .set({ costCents: sql`${runs.costCents} + ${Math.ceil(chargedMilli / 10)}` })
          .where(eq(runs.id, run.id));
      }
    } catch (meterError) {
      console.error("metering failed (stage continues):", meterError);
    }
  }

  await complete(job.id, workerId, { ok: outcome.ok, issues: outcome.issues });

  /* Where does the run go next? Pure decision, no I/O — see lib/pipeline/state. */
  const next = advance(kind, outcome, plan, iteration);

  if (next.type === "fail") {
    await db
      .update(runs)
      .set({ status: "failed", error: next.reason, completedAt: new Date() })
      .where(eq(runs.id, run.id));
    await logEvent(run.id, "orchestrator", "error", `run failed: ${next.reason}`);
    return;
  }

  if (next.type === "await_approval") {
    /* Park the run. Nothing is enqueued: a run waiting on a person must not
       occupy a runner, and this is the only place a run waits. */
    await db
      .update(runs)
      .set({ status: "awaiting_approval", currentStage: "checkpoint" })
      .where(eq(runs.id, run.id));
    await logEvent(
      run.id,
      "checkpoint",
      "success",
      "CHECKPOINT — review the research and the master prompt, then approve or request changes",
    );
    console.log("run parked at the human checkpoint");
    return;
  }

  if (next.type === "finish") {
    await db
      .update(runs)
      .set({ status: "done", completedAt: new Date(), error: null })
      .where(eq(runs.id, run.id));
    await logEvent(run.id, "orchestrator", "success", `run complete — ${next.reason}`);
    console.log("run complete:", next.reason);
    return;
  }

  /* enqueue the next stage and wake a fresh runner so the chain keeps moving
     without waiting for the five-minute sweep. */
  const payload = { ...next.payload };
  if (next.kind === "code" && next.payload?.fixOnly) {
    /* A fix round is scoped to the files the defects actually name, so a small
       defect cannot rewrite a working codebase. The ledger itself rides along:
       a fixer told only the file paths is a fixer told to guess, and every
       guess it gets wrong costs a whole round of the budget. */
    const open = await openIssues(run.id);
    payload.files = filesToRepatch(open);
    payload.issuesText = open
      .slice(0, 12)
      .map(
        (i) =>
          `[${i.severity}] ${i.title}${i.files?.length ? ` (files: ${i.files.join(", ")})` : ""}` +
          (i.detail ? `\n    ${i.detail.replace(/\s+/g, " ").slice(0, 700)}` : ""),
      )
      .join("\n\n")
      .slice(0, 4_000);
  }

  if (next.kind === "code") {
    await db.update(runs).set({ iterations: iteration }).where(eq(runs.id, run.id));
  }

  const enqueued = await db
    .insert(jobs)
    .values({ runId: run.id, kind: next.kind, priority: 0, payload, runAt: new Date() })
    .returning({ id: jobs.id });

  console.log(`enqueued ${next.kind} (job ${enqueued[0].id})`);
  await dispatchRunner({ jobId: enqueued[0].id });
}

try {
  await main();
} catch (error) {
  console.error("runner failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
