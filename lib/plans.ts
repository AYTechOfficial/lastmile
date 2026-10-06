/* Plans — what each tier actually gets, and which models it may use.

   Enforced server-side where a run is created and read by the runner for its
   loop budgets, so a plan can never be escalated from the client.

   `modelTier` is the important new field: it is the switch between the free
   model catalog and the premium one. The concrete models behind each tier are
   operator configuration (admin settings + per-agent pins), not code, so the
   catalog can change without a deploy. Nothing here pretends a payment
   processor exists — Pro is assigned by an operator today. */

export type PlanId = "free" | "pro";

export type ModelTier = "free" | "premium";

export type PlanConfig = {
  id: PlanId;
  label: string;
  /** builds a user may start per UTC day */
  dailyBuilds: number;
  /** quality-loop budget: fix → redeploy → retest rounds */
  maxIterations: number;
  /** how many code-verify rounds before escalating to the human */
  codeVerifyRounds: number;
  /** runs this plan may have in flight at once */
  concurrentRuns: number;
  /** which slice of the model catalog this plan may route to */
  modelTier: ModelTier;
  blurb: string;
};

export const PLANS: Record<PlanId, PlanConfig> = {
  free: {
    id: "free",
    label: "Free",
    dailyBuilds: 3,
    maxIterations: 3,
    codeVerifyRounds: 2,
    concurrentRuns: 1,
    modelTier: "free",
    blurb: "The full pipeline on the free model catalog. 3 builds a day, 3 fix rounds.",
  },
  pro: {
    id: "pro",
    label: "Pro",
    dailyBuilds: 10,
    maxIterations: 8,
    codeVerifyRounds: 4,
    concurrentRuns: 3,
    modelTier: "premium",
    blurb: "Premium models only, 10 builds a day, 8 fix rounds, runs take priority.",
  },
};

export function planOf(value: string | null | undefined): PlanConfig {
  return value === "pro" ? PLANS.pro : PLANS.free;
}

/** The UTC day key used by the usage counters. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}
