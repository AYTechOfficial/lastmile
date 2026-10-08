import type { JobKind, TestReport } from "../lib/domain";
import type { PlanConfig } from "../lib/plans";
import type { StageOutcome } from "../lib/pipeline/state";
import { recordIssues } from "../lib/pipeline/issues";
import { db } from "../lib/db";
import { eq } from "drizzle-orm";
import { runEvents, runs } from "../lib/schema";
import { runResearch } from "../lib/agents/research";
import { runPrompt } from "../lib/agents/prompt";
import { runCoder } from "../lib/agents/coder";
import { runVerifier } from "../lib/agents/verify";
import { runDeployer } from "../lib/agents/deploy";
import { runTester } from "../lib/agents/tester";

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

/* ————————————————————————— prompt ————————————————————————— */

/** The Prompt Agent.

    Runs between research and the human checkpoint, and writes both the spec
    (the contract the Verifier checks) and the master build prompt (what the
    coder follows). Also the target of a change request at the checkpoint: that
    re-runs this stage with the human's note rather than re-running research,
    because the evidence did not change — the interpretation did. */
const prompt: StageExecutor = async (ctx) => {
  const started = Date.now();

  /* The brief research produced. A missing one is survivable: the agent falls
     back to the sentence, which is how a run started before research existed
     still reaches the checkpoint. */
  const brief = (ctx.run.research ?? null) as Parameters<typeof runPrompt>[0]["brief"];

  const result = await runPrompt({
    sentence: ctx.run.sentence,
    brief,
    plan: ctx.plan,
    userId: ctx.userId,
    preferredModel: ctx.run.modelChoice,
    variant: ctx.run.specVariant,
    guidance: typeof ctx.payload.guidance === "string" ? ctx.payload.guidance : null,
    emit: ctx.emit,
    heartbeat: ctx.heartbeat,
  });

  await saveSpec(ctx.run.id, result.spec, result.master);

  await ctx.emit(
    "info",
    `prompt finished in ${Math.round((Date.now() - started) / 1000)}s · spec v${result.spec.variant} · ${result.spec.acceptance} acceptance check(s)`,
  );

  if (!result.usable) {
    return {
      ok: false,
      issues: 0,
      blocking: 0,
      reason: result.reason ?? "the prompt agent produced no usable spec",
      tokens: result.tokens,
    };
  }

  return { ok: true, issues: 0, blocking: 0, tokens: result.tokens };
};

/** Persist the spec and the master prompt together — the checkpoint renders
    both, and a half-written pair would show a spec with no contract behind it. */
async function saveSpec(runId: string, spec: unknown, master: unknown): Promise<void> {
  const { db } = await import("../lib/db");
  const { runs } = await import("../lib/schema");
  const { eq } = await import("drizzle-orm");
  await db.update(runs).set({ spec, masterPrompt: master }).where(eq(runs.id, runId));
}

/* ————————————————————————— code ————————————————————————— */

/** The Coding Agent.

    Two shapes, decided by the payload rather than by the stage: a first pass
    builds the whole product from the master prompt, and a fix round re-patches
    only the files the defect ledger named. Both commit to the same repo, and
    both record the commit sha on the run so the next stage — and a runner that
    replaces this one — resumes from exactly there. */
const code: StageExecutor = async (ctx) => {
  const started = Date.now();
  const firstPass = ctx.payload.firstPass === true || !ctx.run.repoName;
  const files = Array.isArray(ctx.payload.files) ? (ctx.payload.files as string[]) : [];
  /* A deploy failure hands the coder Vercel's own error, so the fix round
     patches the exact files the platform build rejected. */
  const deployError = typeof ctx.payload.deployError === "string" ? (ctx.payload.deployError as string) : null;
  /* The open defect ledger, formatted by the runner when it enqueued this fix
     round — titles, severities and the exact build diagnostics. */
  const issuesText = typeof ctx.payload.issuesText === "string" ? (ctx.payload.issuesText as string) : null;

  const result = await runCoder({
    sentence: ctx.run.sentence,
    slug: ctx.run.slug,
    plan: ctx.plan,
    userId: ctx.userId,
    preferredModel: ctx.run.modelChoice,
    master: (ctx.run.masterPrompt ?? null) as Parameters<typeof runCoder>[0]["master"],
    spec: (ctx.run.spec ?? null) as Parameters<typeof runCoder>[0]["spec"],
    repo: ctx.repo,
    firstPass,
    files,
    deployError,
    issuesText,
    iteration: ctx.iteration,
    emit: ctx.emit,
    heartbeat: ctx.heartbeat,
  });

  if (result.repo) {
    await saveCode(ctx.run.id, result);
  }

  if (!result.ok) {
    return {
      ok: false,
      issues: 0,
      blocking: 0,
      reason: result.reason ?? "the coding agent produced no code",
      tokens: result.tokens,
    };
  }

  /* The round landed and the project still builds, so the defects it was
     answering are closed. A fix that did not actually clear one is re-reported
     by the next verify as a fresh open issue; without this the ledger
     accumulates stale rows and every later round re-reads defects that were
     repaired rounds ago. A round whose self-check could not clear the build
     closes nothing — the verifier is about to say so. */
  const answered = Array.isArray(ctx.payload.issueIds) ? (ctx.payload.issueIds as string[]) : [];
  if (result.buildClean && answered.length > 0) {
    const { markFixed } = await import("../lib/pipeline/issues");
    const closed = await markFixed(ctx.run.id, answered);
    if (closed > 0) {
      await ctx.emit("info", `-> closed ${closed} defect(s) this round answered — the next verify reports what is still real`);
    }
  }

  await ctx.emit(
    "info",
    `code finished in ${Math.round((Date.now() - started) / 1000)}s · ${result.files.length} file(s) · ${result.generated ? "model-written" : "scaffold only"}`,
  );

  return {
    ok: true,
    issues: 0,
    blocking: 0,
    tokens: result.tokens,
    commitSha: result.commitSha,
  };
};

/** Persist where the code landed. Written before the outcome is reported so a
    crash between the commit and the bookkeeping still leaves the run pointing
    at a real commit. */
async function saveCode(runId: string, result: { repo: { owner: string; name: string; url: string } | null; commitSha: string | null }): Promise<void> {
  if (!result.repo) return;
  const { db } = await import("../lib/db");
  const { runs } = await import("../lib/schema");
  const { eq } = await import("drizzle-orm");
  await db
    .update(runs)
    .set({
      repoOwner: result.repo.owner,
      repoName: result.repo.name,
      repoUrl: result.repo.url,
      commitSha: result.commitSha,
    })
    .where(eq(runs.id, runId));
}

/* ————————————————————————— verify ————————————————————————— */

/** The Verifier. Clones the repo, really builds it, sweeps the structure, and
    reviews the code against the master prompt. Every finding lands in the
    defect ledger; the blocking count is what drives the fix loop. */
const verify: StageExecutor = async (ctx) => {
  const started = Date.now();

  const result = await runVerifier({
    plan: ctx.plan,
    userId: ctx.userId,
    preferredModel: ctx.run.modelChoice,
    master: (ctx.run.masterPrompt ?? null) as Parameters<typeof runVerifier>[0]["master"],
    spec: (ctx.run.spec ?? null) as Parameters<typeof runVerifier>[0]["spec"],
    repo: ctx.repo,
    iteration: ctx.iteration,    emit: ctx.emit,
    heartbeat: ctx.heartbeat,
  });

  /* Only critical defects block shipping outright. Majors are repaired while
     the loop has rounds left (the state machine decides), and when the budget is
     spent the build that compiles, serves its routes and scores well must still
     reach a URL — the earlier rule counted every major as blocking, which burned
     the loop budget on advisories and finished runs without ever deploying them. */
  const critical = result.issues.filter((i) => i.severity === "critical").length;
  const majors = result.issues.filter((i) => i.severity === "major").length;
  const recorded = await recordIssues(ctx.run.id, ctx.iteration, "verify", result.issues);

  if (ctx.repo) {
    await db
      .update(runs)
      .set({ qualityScore: result.score })
      .where(eq(runs.id, ctx.run.id));
  }

  await ctx.emit(
    "info",
    `verify finished in ${Math.round((Date.now() - started) / 1000)}s · ${recorded.total} issue(s), ${critical} critical, ${majors} major · score ${result.score}/100`,
  );

  if (!result.ok) {
    return {
      ok: false,
      issues: recorded.total,
      blocking: critical,
      majors,
      reason: result.reason ?? "the verifier could not run",
      tokens: result.tokens,
    };
  }

  return {
    ok: true,
    issues: recorded.total,
    blocking: critical,
    majors,
    verifyScore: result.score,
    tokens: result.tokens,
  };
};

/* ————————————————————————— deploy ————————————————————————— */

/** The Deployer. Sends the verified repo to Vercel and waits for the URL.
    The URL is persisted the moment it exists, so a crash after deploy does
    not redeploy — the run resumes knowing where it lives. */
const deploy: StageExecutor = async (ctx) => {
  const result = await runDeployer({
    plan: ctx.plan,
    emit: ctx.emit,
    heartbeat: ctx.heartbeat,
    repo: ctx.repo ? { owner: ctx.repo.owner, name: ctx.repo.name } : null,
    slug: ctx.run.slug,
  });

  if (!result.ok || !result.url) {
    return {
      ok: false,
      issues: 0,
      blocking: 0,
      reason: result.reason ?? "the deployment did not come up",
      tokens: result.tokens,
    };
  }
  await db
    .update(runs)
    .set({ liveUrl: result.url })
    .where(eq(runs.id, ctx.run.id));

  return { ok: true, issues: 0, blocking: 0, liveUrl: result.url, tokens: result.tokens };
};

/* ————————————————————————— test ————————————————————————— */

/** The Live QA pass. Drives the deployed URL — mechanically first, then with
    the model against the acceptance flows. Blocking findings loop the run
    back to the coder, exactly like verify's do. */
const test: StageExecutor = async (ctx) => {
  const started = Date.now();

  const result = await runTester({
    plan: ctx.plan,
    userId: ctx.userId,
    preferredModel: ctx.run.modelChoice,
    spec: (ctx.run.spec ?? null) as Parameters<typeof runTester>[0]["spec"],
    url: ctx.liveUrl,
    iteration: ctx.iteration,
    emit: ctx.emit,
    heartbeat: ctx.heartbeat,
  });

  const recorded = await recordIssues(ctx.run.id, ctx.iteration, "test", result.issues);

  await db
    .update(runs)
    .set({ testReport: result.report })
    .where(eq(runs.id, ctx.run.id));

  await ctx.emit(
    "info",
    `test finished in ${Math.round((Date.now() - started) / 1000)}s · ${recorded.total} issue(s), ${recorded.blocking} blocking · score ${result.score}/100 · browser: ${result.report.browser}`,
  );

  if (!result.ok) {
    return {
      ok: false,
      issues: recorded.total,
      blocking: recorded.blocking,
      reason: result.reason ?? "the live QA pass could not run",
      tokens: result.tokens,
    };
  }

  return {
    ok: true,
    issues: recorded.total,
    blocking: recorded.blocking,
    testScore: result.score,
    tokens: result.tokens,
  };
};

/** Stages that can actually run. Filled in as each agent lands. */
export const STAGE_EXECUTORS: Partial<Record<JobKind, StageExecutor>> = {
  research,
  prompt,
  code,
  verify,
  deploy,
  test,
};

export function hasExecutor(kind: JobKind): boolean {
  return typeof STAGE_EXECUTORS[kind] === "function";
}

/** Test-report shape, re-exported so stages agree on it with the dashboard. */
export type { TestReport };
