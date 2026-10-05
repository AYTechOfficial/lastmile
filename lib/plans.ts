/* Plans — what each tier actually gets. Enforced server-side in the run
   creation path and read by the orchestrator for loop budgets. Pro is assigned
   by an admin (no payment processor is wired, so nothing here pretends one is). */

export type PlanId = "free" | "pro";

export type PlanConfig = {
  id: PlanId;
  label: string;
  dailyBuilds: number;
  maxIterations: number; // quality-loop budget: fix → redeploy → retest rounds
  codeVerifyRounds: number;
  blurb: string;
};

export const PLANS: Record<PlanId, PlanConfig> = {
  free: {
    id: "free",
    label: "Free",
    dailyBuilds: 3,
    maxIterations: 3,
    codeVerifyRounds: 2,
    blurb: "Full pipeline on free-tier model APIs. 3 builds a day, 3 fix iterations.",
  },
  pro: {
    id: "pro",
    label: "Pro",
    dailyBuilds: 10,
    maxIterations: 8,
    codeVerifyRounds: 4,
    blurb: "More builds a day, 8 fix iterations, priority when agents queue.",
  },
};

export function planOf(value: string | null | undefined): PlanConfig {
  return value === "pro" ? PLANS.pro : PLANS.free;
}

/** Builds started since UTC midnight — the daily quota window. */
export function countTodaysRuns(rows: { createdAt: Date }[]): number {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  return rows.filter((r) => r.createdAt.getTime() >= midnight.getTime()).length;
}
