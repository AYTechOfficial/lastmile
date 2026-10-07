import type { Tone } from "@/components/kit";

/* One vocabulary for run state, shared by the list, the header, the stage rail
   and the receipts so a status never means two different things on one screen. */

export const STAGE_ORDER = [
  "research",
  "spec",
  "checkpoint",
  "prompt",
  "code",
  "verify",
  "deploy",
  "test",
] as const;
export type StageId = (typeof STAGE_ORDER)[number];

export const STAGE_META: Record<StageId, { label: string; role: string; hint: string }> = {
  research: {
    label: "Research",
    role: "Research Agent",
    hint: "Searches the live web for comparable products, pricing, faults and the stack it takes to ship.",
  },
  spec: {
    label: "Spec",
    role: "Spec step",
    hint: "Turns the brief into core flows with acceptance criteria — the tests live QA will run.",
  },
  checkpoint: {
    label: "Your review",
    role: "Human checkpoint",
    hint: "Nothing is built until you approve the spec.",
  },
  prompt: {
    label: "Master prompt",
    role: "Prompt Engineer",
    hint: "Distills the research into a build contract: architecture, design system, every feature and edge case.",
  },
  code: {
    label: "Build",
    role: "Coding Agent",
    hint: "Writes the codebase, builds it for real, and pushes it to your GitHub.",
  },
  verify: {
    label: "Verify",
    role: "Verify Agent",
    hint: "Reviews the code against the contract before anything ships — secrets, imports, spec compliance.",
  },
  deploy: {
    label: "Deploy",
    role: "Deploy Agent",
    hint: "Ships to production and returns the live URL.",
  },
  test: {
    label: "Live QA",
    role: "Testing Agent",
    hint: "Drives the live app with a real browser. Defects loop back to the coder until the score is 100.",
  },
};

export const STATUS_META: Record<string, { label: string; tone: Tone; live: boolean }> = {
  queued: { label: "Queued", tone: "neutral", live: false },
  researching: { label: "Researching", tone: "brand", live: true },
  spec: { label: "Writing spec", tone: "brand", live: true },
  awaiting_approval: { label: "Awaiting you", tone: "warn", live: false },
  prompting: { label: "Engineering prompt", tone: "brand", live: true },
  coding: { label: "Building", tone: "brand", live: true },
  reviewing: { label: "Verifying code", tone: "info", live: true },
  deploying: { label: "Deploying", tone: "info", live: true },
  testing: { label: "Testing live", tone: "info", live: true },
  fixing: { label: "Fixing defects", tone: "warn", live: true },
  done: { label: "Shipped", tone: "pass", live: false },
  failed: { label: "Failed", tone: "bad", live: false },
  stopped: { label: "Stopped", tone: "neutral", live: false },
  // legacy stub-engine statuses
  building: { label: "Building", tone: "brand", live: true },
  verifying: { label: "Verifying", tone: "info", live: true },
};

export function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, tone: "neutral" as Tone, live: false };
}

export function isFinished(status: string): boolean {
  return status === "done" || status === "failed";
}

/** Which stage a run is sitting in, as an index into STAGE_ORDER. */
export function stageIndex(status: string, currentStage?: string): number {
  const byStage = currentStage ? STAGE_ORDER.indexOf(currentStage as StageId) : -1;
  if (byStage >= 0) return byStage;
  switch (status) {
    case "queued":
    case "researching":
      return 0;
    case "spec":
      return 1;
    case "awaiting_approval":
      return 2;
    case "prompting":
      return 3;
    case "coding":
    case "fixing":
      return 4;
    case "reviewing":
      return 5;
    case "deploying":
      return 6;
    case "testing":
    case "done":
      return 7;
    case "stopped":
      return 7;
    default:
      return 0;
  }
}

/** Coarse completion fraction for list progress bars. */
export function progressOf(status: string): number {
  switch (status) {
    case "queued":
      return 0.02;
    case "researching":
      return 0.1;
    case "spec":
      return 0.2;
    case "awaiting_approval":
      return 0.28;
    case "prompting":
      return 0.36;
    case "coding":
      return 0.52;
    case "fixing":
      return 0.62;
    case "reviewing":
      return 0.68;
    case "deploying":
      return 0.78;
    case "testing":
      return 0.9;
    case "done":
    case "failed":
    case "stopped":
      return 1;
    default:
      return 0;
  }
}

/** Total number of core flows the product's own spec promises. */
export function flowCount(spec: { flows?: unknown[] } | null | undefined): number {
  const n = spec?.flows?.length ?? 0;
  return Math.max(n, 4);
}
