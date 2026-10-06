/* The domain contract — every shared shape in one place, with no implementations.

   This file is deliberately dependency-free. Both the UI and the agent pipeline
   import it, and keeping it free of agent/workspace/child-process code is what
   stops the dashboard's module graph from dragging the build farm into the
   serverless bundle. (The previous build died partly because a run-page render
   pulled in a browser driver through an agent import chain.) */

/* ————————————————————————— research ————————————————————————— */

export type Competitor = {
  name: string;
  url: string;
  /** what they actually do, taken from their own site */
  what: string;
  /** pricing as stated on their pricing page, or "not published" */
  pricing: string;
  /** what they leave undone — the opening */
  gaps: string[];
  /** how established they are: funding, size, or age signals found in the sources */
  standing: string | null;
};

/** Every non-obvious assertion the brief makes, tied to where it came from.
    The UI renders claims and sources together so nothing reads as invented. */
export type SourcedClaim = { claim: string; source: string };

export type MarketSaturation = {
  level: "empty" | "thin" | "crowded" | "saturated";
  /** what makes this the verdict — competitor count, funding, churn to name three */
  evidence: string[];
};

export type ProfitOutlook = {
  /** the money story: who pays, how much, and how often */
  model: string;
  /** demand signals actually found — search volume, pricing, job posts, reviews */
  signals: SourcedClaim[];
  /** costs the builder takes on: infrastructure, model tokens, acquisition */
  costs: string[];
  /** an honest read on how hard this is to make pay */
  verdict: string;
};

/** A concrete change to the user's original sentence, with the reason attached.
    These are what the human checkpoint is invited to accept or reject. */
export type SuggestedChange = {
  before: string;
  after: string;
  why: string;
};

export type ResearchBrief = {
  idea: string;
  /** one-line market framing */
  positioning: string;
  audience: string[];
  competitors: Competitor[];
  pricing: SourcedClaim[];
  /** new: how packed the field already is */
  saturation: MarketSaturation;
  /** new: revenue / loss signals found on competitor and market sources */
  economics: SourcedClaim[];
  /** new: whether this can actually earn, and what it costs to try */
  profit: ProfitOutlook;
  /** new: what we would change about the idea, and why */
  changes: SuggestedChange[];
  stack: { name: string; why: string }[];
  productionChecklist: string[];
  flows: { name: string; criteria: string[] }[];
  risks: string[];
  /** the gap this product can own */
  gap: string;
  sources: SourceRef[];
  /** how much real work backed this brief */
  quality: "full" | "search-only" | "offline";
  confidence: number;
  queries: string[];
  reads: number;
  provider: string | null;
  providerLabel: string | null;
  model: string | null;
  searchProvider: string;
  tokens: number;
  elapsedMs: number;
  degradedReason: string | null;
};

export type SourceRef = {
  title: string;
  url: string;
  host: string;
  provider: string;
};

/* ————————————————————————— spec ————————————————————————— */

export type ProductSpec = {
  title: string;
  summary: string;
  /** which research findings this spec is built on */
  positioning: string;
  gap: string;
  audience: string[];
  stack: string[];
  flows: { name: string; criteria: string[] }[];
  dataModel: { table: string; columns: string[] }[];
  routes: { path: string; purpose: string }[];
  scope: { in: string[]; out: string[] };
  risks: string[];
  productionChecklist: string[];
  /** total testable assertions the verification stage will run */
  acceptance: number;
  variant: number;
  origin: "research" | "fallback";
};

/* ————————————————————————— master prompt ————————————————————————— */

export type DesignSystem = {
  look: string;
  colors: { background: string; surface: string; primary: string; accent: string };
  font: string;
};

export type PageSpec = { path: string; purpose: string; sections: string[] };

export type FeatureSpec = { name: string; description: string; priority: "must" | "should" };

export type MasterBuildPrompt = {
  productName: string;
  tagline: string;
  stack: string[];
  dataMode: "client";
  design: DesignSystem;
  pages: PageSpec[];
  features: FeatureSpec[];
  superiority: string[];
  edgeCases: string[];
  qualityBar: string[];
  /** the assembled prose the Coding Agent receives verbatim */
  instructions: string;
  model: string | null;
  providerLabel: string | null;
  tokens: number;
  elapsedMs: number;
};

/* ————————————————————————— verification ————————————————————————— */

export type Severity = "critical" | "major" | "minor";

export type CodeIssue = {
  title: string;
  detail: string | null;
  severity: Severity;
  source: "verify";
};

export type VerifyResult = {
  ok: boolean;
  issues: CodeIssue[];
  score: number;
};

/** One line of the master prompt, and whether the codebase actually satisfies it.
    This is what makes "verify against the master prompt" a real check rather than
    a model's opinion: every requirement gets a verdict and a file reference. */
export type RequirementCheck = {
  /** the requirement, quoted or paraphrased from the master prompt */
  requirement: string;
  status: "met" | "partial" | "missing";
  /** files that satisfy or should satisfy it */
  files: string[];
  note: string | null;
};

export type ConformanceReport = {
  checks: RequirementCheck[];
  met: number;
  partial: number;
  missing: number;
  score: number;
};

/* ————————————————————————— live QA ————————————————————————— */

export type TestStep =
  | { action: "goto"; url: string }
  | { action: "click"; selector: string }
  | { action: "fill"; selector: string; value: string }
  | { action: "press"; key: string }
  | { action: "reload" }
  | { action: "expectText"; text: string }
  | { action: "expectSelector"; selector: string }
  | { action: "expectUrl"; contains: string }
  | { action: "resize"; width: number; height: number };

/** Test flows are generated per project from that project's spec — never a
    fixed template, because two products do not share a single happy path. */
export type FlowPlan = {
  name: string;
  /** why this flow matters for this product */
  intent: string;
  steps: TestStep[];
};

export type FlowResult = {
  name: string;
  passed: boolean;
  assertions: number;
  attempts: number;
  durationMs: number;
  failure: string | null;
};

export type TestReport = {
  flows: FlowResult[];
  consoleErrors: string[];
  screenshots: string[];
  passedAssertions: number;
  totalAssertions: number;
  score: number;
  browser: string;
};

/* ————————————————————————— the event stream ————————————————————————— */

export type AgentEventKind =
  | "info"
  | "command"
  | "success"
  | "warn"
  | "error"
  | "url"
  | "flow";

export type AgentEvent = {
  kind: AgentEventKind;
  line: string;
  /** optional structured payload the engine persists alongside the event */
  flow?: {
    position: number;
    name: string;
    assertions: number;
    status: "pass" | "fixed";
    attempts: number;
    durationMs: number;
  };
};

export type Emit = (event: AgentEvent) => Promise<void> | void;

/* ————————————————————————— the pipeline ————————————————————————— */

export const PIPELINE_STAGES = [
  "research",
  "checkpoint",
  "prompt",
  "code",
  "verify",
  "deploy",
  "test",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Stages a worker can be asked to run as a job. The checkpoint is not a job —
    it is a wait on a human, so it never occupies a worker. */
export const JOB_KINDS = ["research", "prompt", "code", "verify", "deploy", "test"] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export type TestReportDTO = {
  consoleErrors: string[];
  screenshotCount: number;
  flowsTotal: number;
  flowsPassed: number;
  assertions: number;
  score: number;
  browser: string;
};
