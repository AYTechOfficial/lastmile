import type { JobKind, TestReport } from "../lib/domain";
import type { PlanConfig } from "../lib/plans";
import type { StageOutcome } from "../lib/pipeline/state";
import type { runEvents, runs } from "../lib/schema";
import { runResearch } from "../lib/agents/research";

/* The stage registry.

   Each stage is a function of (run, plan, iteration) that does real work and
   reports what it found. The runner owns everything around it — claiming,
   heartbeats, leases, retries, advancing to the next stage — so a stage
   implementation never has to think about durability.

   A stage that is not implemented yet is simply absent from this map, and the
   runner fails the job with a clear reason. That is deliberate: the alternative
   is a placeholder that emits plausible-looking events, and a pipeline that
   appears to work while doing nothing is worse than one that says it is not
   ready. Dashboard previews of fake progress are exactly what this rebuild is
   meant to remove. */

export type RunRow = typeof runs.$inferSelect;
export type EventRow = typeof runEvents.$inferSelect;

export type StageContext = {
  run: RunRow;
  /** the plan that governs this run's loop budgets and model tier */
  plan: PlanConfig;
  /** quality-loop round, starting at 1 */
  iteration: number;
  /** stage inputs: guidance from a checkpoint, the files a fix should touch */
  payload: Record<string, unknown>;

  /** Append a line to the run's live feed. Writes are serialised per run, so
      concurrent stages cannot corrupt the sequence. */
  emit: (kind: "info" | "command" | "success" | "warn" | "error" | "url", line: string) => Promise<void>;

  /** Keep the lease alive during long work. A stage that runs for minutes MUST
      call this periodically, or the job will be handed to another runner. */
  heartbeat: () => Promise<void>;

  /** The iteration's live URL, when a deploy has already happened. */
  liveUrl: string | null;

  /** Where the generated code lives — the repo IS the build workspace. */
  repo: { owner: string; name: string } | null;

  /** The user who owns this run — how a stage resolves their own keys. */
  userId: string;
};

export type StageExecutor = (ctx: StageContext) => Promise<StageOutcome>;

/* ————————————————————————— research ————————————————————————— */

/** The Research Agent.

    `ok: true` is returned for every outcome the agent can produce, including a
    degraded one, because the agent's contract is that it always yields a brief
    — and a brief that says it was built without a model is still a brief the
    pipeline can carry forward. Only a genuinely unusable result fails the
    stage, which is what `result.usable` reports. */
const research: StageExecutor = async (ctx) => {
  const started = Date.now();

  const result = await runResearch({
    sentence: ctx.run.sentence,
    plan: ctx.plan,
    userId: ctx.userId,
    preferredModel: ctx.run.modelChoice,
    preferredSearch: ctx.run.searchChoice,
    emit: ctx.emit,
    heartbeat: ctx.heartbeat,
  });

  /* The brief is the stage's product: persist it before reporting, so a later
     stage (and a page refresh) reads the same thing the log just described. */
  await saveResearch(ctx.run.id, result.brief);

  const elapsed = Date.now() - started;
  await ctx.emit(
    "info",
    `research finished in ${Math.round(elapsed / 1000)}s · ${result.brief.sources.length} source(s) · quality ${result.brief.quality}`,
  );

  if (!result.usable) {
    return {
      ok: false,
      issues: 0,
      blocking: 0,
      reason: result.reason ?? "the research agent produced no usable brief",
      tokens: result.tokens,
    };
  }

  return { ok: true, issues: 0, blocking: 0, tokens: result.tokens };
};

/** Persist the brief. Imported lazily so the stage registry stays cheap to load
    for callers that only need `hasExecutor`. */
async function saveResearch(runId: string, brief: unknown): Promise<void> {
  const { db } = await import("../lib/db");
  const { runs } = await import("../lib/schema");
  const { eq } = await import("drizzle-orm");
  await db.update(runs).set({ research: brief }).where(eq(runs.id, runId));
}

/** Stages that can actually run. Filled in as each agent lands. */
export const STAGE_EXECUTORS: Partial<Record<JobKind, StageExecutor>> = {
  research,
};

export function hasExecutor(kind: JobKind): boolean {
  return typeof STAGE_EXECUTORS[kind] === "function";
}

/** Test-report shape, re-exported so stages agree on it with the dashboard. */
export type { TestReport };
