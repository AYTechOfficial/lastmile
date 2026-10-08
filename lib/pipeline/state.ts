import type { JobKind, PipelineStage } from "../domain";
import type { PlanConfig } from "../plans";
import type { RunIssue } from "./issues";

/* The stage machine — pure decisions, no I/O and no executors.

   This file is safe to import from the dashboard, which is why it is separate
   from the executors. The dashboard needs to know what stage comes next so it
   can show it; it must never pull in the code that runs a build.

   The shape of a run — note where the checkpoint sits. Research alone is not
   enough to react to: the user reviews the brief *and* the master prompt the
   Prompt Agent wrote from it, and only then does anything get built.

     research ▶ prompt ──▶  HUMAN CHECKPOINT  ──▶ code ▶ verify ──┐
                                ▲                               │ issues?
                        (the only place a run waits on a person) ├─ yes ─▶ code
                                                                │   (iteration + 1)
                                                                └─ no  ─▶ deploy ▶ test
                                                                              │
                                                                  failures? ──┤
                                                                              └─▶ code
                                                                                  (iteration + 1)

   A change request at the checkpoint re-runs the Prompt Agent (prompt →
   checkpoint again), never the research: the evidence did not change, the
   interpretation did.

   Two rules keep the loop honest:

     1. A loop always ends. `plan.maxIterations` caps it, and hitting the cap is
        a visible outcome (`finish` with a reason), never a silent stop.
     2. A failing stage is retried a bounded number of times before the run is
        marked failed. Nothing retries forever. */

export const BAND = {
  research: { from: 1, to: 999 },
  checkpoint: { from: 1000, to: 1999 },
  post: { from: 2000, to: 2999 },
} as const;

export type Band = (typeof BAND)[keyof typeof BAND];

/** Sequence numbers live in bands so two phases can never interleave in the
    terminal and rewrite each other's ordering. */
export function seqInBand(band: Band): number {
  return band.from;
}

export type PipelineState = {
  stage: PipelineStage;
  /** quality-loop round, starting at 1 */
  iteration: number;
  /** the last stage that succeeded, for resuming a crashed runner */
  lastCompleted: JobKind | null;
  /** set when a stage produced a live URL, so later stages do not re-deploy */
  liveUrl: string | null;
  /** the commit the runner last produced — a resume starts exactly here */
  commitSha: string | null;
  /** score from the last verify pass, for the quality gate */
  verifyScore: number | null;
  /** score from the last live-QA pass */
  testScore: number | null;
};

export function initialState(): PipelineState {
  return {
    stage: "research",
    iteration: 1,
    lastCompleted: null,
    liveUrl: null,
    commitSha: null,
    verifyScore: null,
    testScore: null,
  };
}

export type StageOutcome = {
  /** did the stage itself run to completion */
  ok: boolean;
  /** defect count this stage produced (0 means clean) */
  issues: number;
  /** defects that must be fixed before shipping */
  blocking: number;
  /** real defects that are not fatal — repaired while the loop has rounds
      left, shipped only when it does not */
  majors?: number;
  /** the reason a stage failed outright, if it did */
  reason?: string;
  liveUrl?: string | null;
  commitSha?: string | null;
  verifyScore?: number | null;
  testScore?: number | null;
  tokens?: number;
};

export type Advance =
  | { type: "enqueue"; kind: JobKind; iteration: number; payload?: Record<string, unknown> }
  /** the run is parked until a human approves or requests changes */
  | { type: "await_approval" }
  | { type: "finish"; reason: string }
  | { type: "fail"; reason: string };

/** What happens after a stage. Total function of (stage, outcome, plan) — no
    hidden state, so it is testable and the UI can mirror it. */
export function advance(
  stage: JobKind,
  outcome: StageOutcome,
  plan: PlanConfig,
  iteration: number,
): Advance {
  if (!outcome.ok) {
    return { type: "fail", reason: outcome.reason ?? `${stage} stage failed` };
  }

  switch (stage) {
    case "research":
      /* Research hands off to the Prompt Agent, which turns the brief into the
         master prompt. The human gate is after that, not here. */
      return { type: "enqueue", kind: "prompt", iteration };

    case "prompt":
      /* The single human gate: the brief and the master prompt are both on
         screen, and nothing is built until a person clears it. Deliberately
         enqueues nothing — a run parked here must not occupy a runner. */
      return { type: "await_approval" };

    case "code":
      return { type: "enqueue", kind: "verify", iteration };

    case "verify": {
      const roundsUsed = iteration;
      if (outcome.blocking > 0) {
        if (roundsUsed >= plan.maxIterations) {
          /* Nothing ships broken. The budget is spent with critical defects
             still open, so the run ends as a failure the user can retry —
             deploying anyway would trade honesty for a URL. */
          return {
            type: "fail",
            reason: `Quality loop hit its ${plan.maxIterations}-round budget with ${outcome.blocking} critical issue(s) open`,
          };
        }
        return {
          type: "enqueue",
          kind: "code",
          iteration: iteration + 1,
          payload: { fixOnly: true, from: "verify" },
        };
      }

      /* Majors are real defects, not advisories: the reviewer named the screen
         and the state that makes it unreachable, and the file to open. Shipping
         past one docks the run's score and hands the user a product the pipeline
         already knew was wrong — it recorded the defect, deployed anyway, and
         never spent a round on the repair.

         So majors ride the loop exactly as criticals do, with the one difference
         that keeps the "every run reaches a URL" rule: when the budget is spent
         they stop blocking and the run deploys, leaving the open defects in the
         ledger where the user can see them. */
      if ((outcome.majors ?? 0) > 0 && roundsUsed < plan.maxIterations) {
        return {
          type: "enqueue",
          kind: "code",
          iteration: iteration + 1,
          payload: { fixOnly: true, from: "verify" },
        };
      }

      return { type: "enqueue", kind: "deploy", iteration };
    }

    case "deploy":
      /* A deploy that breaks goes back to the coder with Vercel's own error —
         the verifier passed the build locally, so a platform build failure is
         a defect like any other, and the fix round should name it. */
      if (!outcome.ok) {
        if (iteration >= plan.maxIterations) {
          return {
            type: "fail",
            reason: outcome.reason ?? "the deployment failed and the fix budget is spent",
          };
        }
        return {
          type: "enqueue",
          kind: "code",
          iteration: iteration + 1,
          payload: { fixOnly: true, from: "deploy", deployError: outcome.reason ?? "the Vercel build failed" },
        };
      }
      return { type: "enqueue", kind: "test", iteration };

    case "test": {
      if (outcome.blocking > 0) {
        if (iteration >= plan.maxIterations) {
          /* The URL exists at this point, so "done" here is honest: the user
             can open the product AND see exactly what live QA still objects
             to in the ledger. */
          return {
            type: "finish",
            reason: `shipped with ${outcome.blocking} open issue(s) — the ${plan.maxIterations}-round budget is spent, the ledger has the details`,
          };
        }
        return {
          type: "enqueue",
          kind: "code",
          iteration: iteration + 1,
          payload: { fixOnly: true, from: "test" },
        };
      }
      return { type: "finish", reason: "Verified against the master prompt and on the live URL" };
    }
  }
}

/** Files the fix round should touch. Surgical re-patching keeps a quality loop
    cheap and stops a small defect from rewriting a working codebase. */
export function filesToRepatch(issues: RunIssue[]): string[] {
  const set = new Set<string>();
  for (const issue of issues) {
    for (const f of issue.files ?? []) set.add(f);
  }
  return [...set].sort();
}
