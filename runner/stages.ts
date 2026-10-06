import type { JobKind, TestReport } from "../lib/domain";
import type { PlanConfig } from "../lib/plans";
import type { StageOutcome } from "../lib/pipeline/state";
import type { runEvents, runs } from "../lib/schema";

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
};

export type StageExecutor = (ctx: StageContext) => Promise<StageOutcome>;

/** Stages that can actually run. Filled in as each agent lands. */
export const STAGE_EXECUTORS: Partial<Record<JobKind, StageExecutor>> = {};

export function hasExecutor(kind: JobKind): boolean {
  return typeof STAGE_EXECUTORS[kind] === "function";
}

/** Test-report shape, re-exported so stages agree on it with the dashboard. */
export type { TestReport };
