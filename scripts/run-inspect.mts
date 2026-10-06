/* Look at one run's durable state — and create or remove a throwaway one.

   The queue lives in Postgres and the runner lives on a CI machine, so when
   something goes wrong there is no console to read. This prints the rows that
   decide what happens next: the run's status, the job's attempts and lease, the
   agent_runs ledger, and the event feed the dashboard renders.

     npx tsx scripts/run-inspect.mts create [--email a@b.c] [--stage research]
     npx tsx scripts/run-inspect.mts show <runId>
     npx tsx scripts/run-inspect.mts cleanup <runId>

   `create` makes a run that exists only to be claimed, so the hosted runner can
   be exercised for real. `cleanup` deletes it; jobs, events and agent_runs
   cascade with the run. */

import { config } from "dotenv";
import { and, desc, eq, sql as raw } from "drizzle-orm";

config({ path: ".env.local", quiet: true });

const { db, client } = await import("../lib/db");
const { runs, jobs, agentRuns, runEvents, users } = await import("../lib/schema");
const { enqueue } = await import("../lib/queue");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const mode = process.argv[2];
const runIdArg = process.argv[3];

function stamp(d: Date | null): string {
  if (!d) return "-";
  const ms = Date.now() - new Date(d).getTime();
  return ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60_000)}m ago`;
}

async function create(): Promise<void> {
  const email = flag("--email");
  const stage = (flag("--stage") ?? "research") as "research";

  const [owner] = await db
    .select({ id: users.id, email: users.email, plan: users.plan })
    .from(users)
    .where(email ? eq(users.email, email) : raw`true`)
    .orderBy(desc(users.createdAt))
    .limit(1);

  if (!owner) {
    console.error("No user to attach a run to. Run `node scripts/db-seed.mjs` first.");
    process.exit(1);
  }

  const [{ n: existing }] = (await db.execute(
    raw`select count(*)::int as n from lastmile.runs where user_id = ${owner.id}`,
  )) as unknown as { n: number }[];

  const [run] = await db
    .insert(runs)
    .values({
      userId: owner.id,
      runNumber: existing + 1,
      sentence: "runner probe — safe to delete",
      title: "Runner probe",
      slug: `runner-probe-${Date.now()}`,
      status: "queued",
      currentStage: stage,
      planId: owner.plan,
      startedAt: new Date(),
    })
    .returning();

  const job = await enqueue({ runId: run.id, kind: stage });
  console.log(`run  ${run.id}  (owner ${owner.email}, plan ${owner.plan})`);
  console.log(`job  ${job.id}  stage ${stage}, status ${job.status}`);
}

async function show(runId: string): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) {
    console.error(`No run ${runId}`);
    process.exit(1);
  }

  console.log(`run ${run.id}`);
  console.log(`  status=${run.status} stage=${run.currentStage} iterations=${run.iterations} plan=${run.planId}`);
  console.log(`  error=${run.error ?? "-"} liveUrl=${run.liveUrl ?? "-"}`);

  const jobRows = await db.select().from(jobs).where(eq(jobs.runId, runId));
  console.log(`\njobs (${jobRows.length})`);
  for (const j of jobRows) {
    console.log(
      `  ${j.kind.padEnd(9)} ${j.status.padEnd(9)} attempts=${j.attempts}/${j.maxAttempts}` +
        ` claimedBy=${j.claimedBy ?? "-"} heartbeat=${stamp(j.heartbeatAt)} runAt=${stamp(j.runAt)}`,
    );
    if (j.error) console.log(`            error: ${j.error}`);
  }

  const ledger = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.runId, runId))
    .orderBy(agentRuns.iteration);
  console.log(`\nagent_runs (${ledger.length})`);
  for (const a of ledger) {
    console.log(`  ${a.agent.padEnd(9)} iter=${a.iteration} ${a.status.padEnd(7)} ${a.elapsedMs ?? "-"}ms`);
    if (a.error) console.log(`            error: ${a.error}`);
  }

  const feed = await db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(desc(runEvents.seq))
    .limit(15);
  console.log(`\nevent feed (latest ${feed.length}, newest first)`);
  for (const e of feed.reverse()) {
    console.log(`  #${String(e.seq).padStart(3)} ${e.stage.padEnd(12)} ${e.kind.padEnd(7)} ${e.line}`);
  }
}

async function cleanup(runId: string): Promise<void> {
  const [{ n: before }] = (await db.execute(
    raw`select count(*)::int as n from lastmile.jobs where run_id = ${runId}`,
  )) as unknown as { n: number }[];
  const deleted = await db.delete(runs).where(eq(runs.id, runId)).returning({ id: runs.id });
  const [{ n: after }] = (await db.execute(
    raw`select count(*)::int as n from lastmile.jobs where run_id = ${runId}`,
  )) as unknown as { n: number }[];
  console.log(`deleted run ${deleted.length ? runId : "(not found)"}; jobs ${before} -> ${after}`);
  const orphanEvents = await db
    .select({ id: runEvents.id })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId)));
  const orphanLedger = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.runId, runId));
  console.log(`orphans left: ${orphanEvents.length} events, ${orphanLedger.length} agent_runs`);
}

try {
  if (mode === "create") await create();
  else if (mode === "show" && runIdArg) await show(runIdArg);
  else if (mode === "cleanup" && runIdArg) await cleanup(runIdArg);
  else {
    console.error("usage: run-inspect.mts create|show <runId>|cleanup <runId>");
    process.exitCode = 1;
  }
} catch (error) {
  console.error("failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
