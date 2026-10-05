import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRuns, runFlows, runIssues, runs, users } from "@/lib/schema";
import { BAND, logRunEvent } from "@/lib/run-engine";
import { runAsUser } from "@/lib/ai/context";
import type { ResearchBrief } from "@/lib/agents/research";
import { fallbackSpec, specFromBrief, type ProductSpec } from "@/lib/agents/spec";
import { engineerPrompt, type MasterBuildPrompt } from "@/lib/agents/prompt-engineer";
import {
  generateCodebase,
  writeScaffold,
  finish as coderFinish,
  patchForIssues,
  patchBuildErrors,
} from "@/lib/agents/coder";
import { verifyCodebase } from "@/lib/agents/verifier";
import { testLive, type TestReport } from "@/lib/agents/tester";
import { commitFiles, createRepo, githubTokenForUser, parseRepoUrl, restoreWorkspaceFromGithub } from "@/lib/platform/github";
import { resolveInfraToken } from "@/lib/platform/settings";
import { RemoteBuildError, deployToRender, deployToVercel, fetchVercelBuildLog } from "@/lib/platform/vercel";
import { zipWorkspace } from "@/lib/platform/workspace";
import { planOf } from "@/lib/plans";

/* The Orchestrator — owns every post-approval stage.

   State machine (after the human approves the spec):

     prompt → code → verify → deploy → test ─┬─ score 100 → ship
                                             └─ defects  → fix → code → …
                                              (capped by the plan budget)

   Everything it does is persisted: events land in run_events (the live
   terminal), agent invocations in agent_runs (telemetry), defects in
   run_issues, test results in run_flows, and the cursor itself in
   runs.pipeline_state — so a crashed job resumes exactly where it stopped
   instead of starting over. A kill flag is honored between every stage. */

export type PipelineStage = "prompt" | "code" | "verify" | "deploy" | "test";

export type RepoRef = { owner: string; name: string; htmlUrl: string };

export type PipelineState = {
  stage: PipelineStage;
  iteration: number; // 0 = first pass; increments on every fix loop
  scores: number[]; // quality score per test round
  repo: RepoRef | null;
  deployedUrl: string | null;
  buildOk: boolean;
  buildOutput: string;
  verifyScore: number | null;
  /** true once the workspace copy was released after GitHub+Vercel both held
      the code — an iterate/retry must restore from the repo before coding */
  released?: boolean;
};

function initialState(stage: PipelineStage = "prompt"): PipelineState {
  return {
    stage,
    iteration: 0,
    scores: [],
    repo: null,
    deployedUrl: null,
    buildOk: false,
    buildOutput: "",
    verifyScore: null,
  };
}

type RunRow = typeof runs.$inferSelect;

async function loadRun(runId: string): Promise<RunRow | null> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  return run ?? null;
}

function stateOf(run: RunRow): PipelineState {
  return (run.pipelineState as unknown as PipelineState | null) ?? initialState();
}

async function saveState(runId: string, state: PipelineState): Promise<void> {
  await db.update(runs).set({ pipelineState: state }).where(eq(runs.id, runId));
}

async function setRun(runId: string, patch: Partial<typeof runs.$inferInsert>): Promise<void> {
  await db.update(runs).set(patch).where(eq(runs.id, runId));
}

async function upsertAgent(
  runId: string,
  agent: string,
  values: Partial<typeof agentRuns.$inferInsert>,
): Promise<void> {
  await db
    .insert(agentRuns)
    .values({ runId, agent, ...values })
    .onConflictDoUpdate({ target: [agentRuns.runId, agentRuns.agent], set: { ...values } });
}

export type PipelineEmit = (event: {
  kind: "info" | "command" | "success" | "warn" | "error" | "flow" | "url" | "loop";
  line: string;
  flow?: { position: number; name: string; assertions: number; status: "pass" | "fixed" | "fail"; attempts: number; durationMs: number };
}) => Promise<void>;

function emitter(runId: string, stage: string): PipelineEmit {
  return async (event) => {
    await logRunEvent(runId, stage, BAND.post, event.kind === "loop" ? "warn" : event.kind, event.line);
    if (event.flow) await upsertFlow(runId, event.flow);
  };
}

/* The flow upsert needs the real conflict update; done separately to keep the
   emitter readable. */
async function upsertFlow(
  runId: string,
  flow: { position: number; name: string; assertions: number; status: "pass" | "fixed" | "fail"; attempts: number; durationMs: number },
): Promise<void> {
  await db
    .insert(runFlows)
    .values({
      runId,
      position: flow.position,
      name: flow.name,
      assertions: flow.assertions,
      status: flow.status,
      attempts: flow.attempts,
      durationMs: flow.durationMs,
    })
    .onConflictDoUpdate({
      target: [runFlows.runId, runFlows.position],
      set: {
        name: flow.name,
        assertions: flow.assertions,
        status: flow.status,
        attempts: flow.attempts,
        durationMs: flow.durationMs,
      },
    });
}

/* ————————————————————————— stages ————————————————————————— */

async function stagePrompt(run: RunRow, state: PipelineState, plan: ReturnType<typeof planOf>): Promise<PipelineState> {
  const emit = emitter(run.id, "prompt");
  await setRun(run.id, { status: "prompting", currentStage: "prompt" });
  await upsertAgent(run.id, "prompt", { status: "running", startedAt: new Date(), detail: "engineering the master build prompt" });

  const brief = run.research as unknown as ResearchBrief | null;
  const spec = (run.spec as unknown as ProductSpec | null) ?? fallbackSpec(run.title, run.specVariant);
  if (!brief) {
    // an old run approved without stored research: rebuild a minimal brief
    const minimal = specFromBrief(fallbackBriefFromSpec(spec), run.specVariant);
    const master = await engineerPrompt(run.title, fallbackBriefFromSpec(spec), minimal, plan.id, emit);
    await setRun(run.id, { masterPrompt: master });
    await upsertAgent(run.id, "prompt", { status: "done", detail: master.features.length + " features · " + master.superiority.length + " edges", endedAt: new Date(), tokens: master.tokens, model: master.model, provider: master.providerLabel, elapsedMs: master.elapsedMs });
    return { ...state, stage: "code" };
  }

  const master = await engineerPrompt(run.title, brief, spec, plan.id, emit);
  await setRun(run.id, {
    masterPrompt: master,
    tokens: run.tokens + master.tokens,
  });
  await upsertAgent(run.id, "prompt", {
    status: "done",
    detail: master.features.length + " features · " + master.superiority.length + " competitive edges",
    endedAt: new Date(),
    tokens: master.tokens,
    model: master.model,
    provider: master.providerLabel,
    elapsedMs: master.elapsedMs,
  });
  return { ...state, stage: "code" };
}

function fallbackBriefFromSpec(spec: ProductSpec): ResearchBrief {
  return {
    idea: spec.title,
    positioning: spec.positioning,
    audience: spec.audience,
    competitors: [],
    pricing: [],
    stack: spec.stack.map((name) => ({ name, why: "from the approved spec" })),
    productionChecklist: spec.productionChecklist,
    flows: spec.flows,
    risks: spec.risks,
    gap: spec.gap,
    sources: [],
    quality: "offline",
    confidence: 0.4,
    queries: [],
    reads: 0,
    provider: null,
    providerLabel: null,
    model: null,
    searchProvider: "none",
    tokens: 0,
    elapsedMs: 0,
    degradedReason: "rebuilt from the approved spec",
  };
}

async function stageCode(run: RunRow, state: PipelineState, plan: ReturnType<typeof planOf>): Promise<PipelineState> {
  const emit = emitter(run.id, "code");
  await setRun(run.id, { status: "coding", currentStage: "code" });
  const master = run.masterPrompt as unknown as MasterBuildPrompt | null;
  if (!master) {
    await logRunEvent(run.id, "code", BAND.post, "error", "-> no master prompt found — the pipeline cannot code without it");
    throw new Error("pipeline state missing master prompt");
  }

  await upsertAgent(run.id, "code", { status: "running", startedAt: new Date(), detail: "writing the codebase" });
  /* a shipped run's workspace copy was released after deploy — an iteration
     refills it from the repo BEFORE the scaffold would otherwise clobber it */
  state = await ensureWorkspaceReady(run, state, emit);
  writeScaffold(run.id, master);
  await logRunEvent(run.id, "code", BAND.post, "info", "-> scaffold written (package.json, tsconfig, configs) — stack: " + master.stack.join(", "));

  const result = await generateCodebase(run.id, master, plan.id, emit);
  if (!result.ok) {
    await upsertAgent(run.id, "code", { status: "failed", error: result.error ?? "build failed", endedAt: new Date() });
    throw new Error(result.error ?? "the codebase could not be built");
  }

  await upsertAgent(run.id, "code", { status: "done", detail: result.files.length + " files · build passing", endedAt: new Date() });
  return { ...state, buildOk: true, buildOutput: "", stage: "verify" };
}

async function pushToGithub(run: RunRow, state: PipelineState, master: MasterBuildPrompt, emit: PipelineEmit): Promise<PipelineState> {
  if (state.repo) return state;

  /* Code needs a permanent home. The user's own GitHub link wins when present
     (repos land in THEIR account), and every user falls back to the platform's
     hosted account — the OAuth app in lib/auth.ts signs people in, but sign-in
     alone does not grant repo rights to unlinked users, so "hosted" covers
     everyone else. With a hosted repo the code is safe on GitHub + the deploy
     pulls from the pipeline itself, and the workspace copy can be released. */
  const userToken = await githubTokenForUser(run.userId);
  const platformToken = userToken ?? (await resolveInfraToken("github"));
  if (!platformToken) {
    await emit({ kind: "warn", line: "-> no github token available (connect GitHub in Settings, or ask the operator to add one in Admin → Infrastructure) — the code stays in the workspace and the .zip download remains" });
    return state;
  }
  const token: string = platformToken;
  const hosted = !userToken;
  if (hosted) {
    await emit({ kind: "info", line: "-> github not connected — hosting the code on the platform's github (lastmile-builds)" });
  }

  try {
    const name =
      master.productName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) ||
      "lastmile-run-" + run.id.slice(0, 6);
    await emit({ kind: "info", line: "-> creating github repo: " + name });
    const repo = await createRepo(token, {
      name,
      description: master.productName + " — " + master.tagline,
      isPrivate: false,
    });
    const { listFiles, readWorkspaceFile } = await import("@/lib/platform/workspace");
    const files = listFiles(run.id)
      .filter((f) => !f.endsWith("/"))
      .map((path) => ({ path, content: readWorkspaceFile(run.id, path) ?? "" }));
    const { commitSha } = await commitFiles(token, repo, files, "Initial build — " + files.length + " files\n\nGenerated by LastMile from: " + run.title);
    await emit({ kind: "success", line: "-> pushed " + files.length + " files to " + repo.htmlUrl + " (commit " + commitSha.slice(0, 7) + ")" + (hosted ? " — platform-hosted; connect your GitHub in Settings to own the repo" : "") });
    await setRun(run.id, { repoUrl: repo.htmlUrl });
    await upsertAgent(run.id, "code", { detail: files.length + " files pushed to github" });
    return { ...state, repo: { owner: repo.owner, name: repo.name, htmlUrl: repo.htmlUrl } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await emit({ kind: "warn", line: "-> github push failed (" + msg.slice(0, 160) + ") — continuing without a repo; the zip download still works" });
    return state;
  }
}

async function stageVerify(run: RunRow, state: PipelineState, plan: ReturnType<typeof planOf>): Promise<PipelineState> {
  const emit = emitter(run.id, "verify");
  await setRun(run.id, { status: "reviewing", currentStage: "verify" });
  await upsertAgent(run.id, "verify", { status: "running", startedAt: new Date(), detail: "reviewing the code before deploy" });

  const master = run.masterPrompt as unknown as MasterBuildPrompt;
  const review = await verifyCodebase(run.id, master, plan.id, state.buildOk, state.buildOutput, emit);
  await upsertAgent(run.id, "verify", {
    status: review.ok ? "done" : "failed",
    detail: review.score + "/100 code confidence",
    endedAt: new Date(),
  });

  /* critical issues are fixed right here — majors/minors ride along to live QA */
  if (!review.ok) {
    for (let round = 0; round < plan.codeVerifyRounds; round++) {
      await emit({ kind: "loop", line: "[LOOP] " + review.issues.filter((i) => i.severity === "critical").length + " critical issue(s) — sending back to the coder (review round " + (round + 1) + ")" });
      const patched = await patchForIssues(run.id, master, plan.id, review.issues.filter((i) => i.severity !== "minor"), emit);
      if (!patched) break;
      const result = await coderFinish(run.id, master, plan.id, emit, 2);
      if (result.ok) {
        await setRun(run.id, { status: "reviewing", currentStage: "verify" });
        const second = await verifyCodebase(run.id, master, plan.id, true, "", emit);
        if (second.ok) {
          await upsertAgent(run.id, "verify", { status: "done", detail: second.score + "/100 after fixes", endedAt: new Date() });
          return { ...state, buildOk: true, verifyScore: second.score, stage: "deploy" };
        }
        review.issues = second.issues;
        continue;
      }
    }
    throw new Error("critical issues survived the code-review loop: " + review.issues.filter((i) => i.severity === "critical").map((i) => i.title).slice(0, 3).join("; "));
  }

  return { ...state, buildOk: true, verifyScore: review.score, stage: "deploy" };
}

/* ————————————————————————— workspace lifecycle —————————————————————————

   The repo on GitHub is the source of truth, not the local disk. Once a run
   is verified AND deployed, both GitHub and the host hold the code, so the
   platform releases its copy: the .builds/<runId>/ tree is deleted and the
   storage footprint of a finished run drops to metadata (the Supabase rows
   never held code — they hold events, scores, and state). A later iteration
   refills the workspace from the repo (ensureWorkspaceReady) before the
   coder touches anything, so "delete after ship" costs nothing and an old
   project can always be picked back up exactly as it shipped. */

/** Delete the run's workspace copy of the code when the repo + host hold it. */
async function releaseWorkspace(run: RunRow, state: PipelineState, liveUrl: string, emit: PipelineEmit): Promise<void> {
  if (!state.repo || !liveUrl) return;
  const { deleteWorkspace } = await import("@/lib/platform/workspace");
  try {
    deleteWorkspace(run.id);
    await emit({ kind: "info", line: "-> workspace released — the code lives on github + " + new URL(liveUrl).host + "; iterations will restore it from the repo" });
  } catch {
    /* the tree is a cache; failing to delete it is never a deploy failure */
  }
}

/** Make sure the workspace holds code before the coder runs: refill it from
 *  the repo when a shipped run's copy was released. */
async function ensureWorkspaceReady(run: RunRow, state: PipelineState, emit: PipelineEmit): Promise<PipelineState> {
  const { fileCount } = await import("@/lib/platform/workspace");
  if (fileCount(run.id) > 0) return state;

  const parsed = run.repoUrl ? parseRepoUrl(run.repoUrl) : null;
  const repoRef = state.repo ?? (parsed ? { ...parsed, htmlUrl: run.repoUrl! } : null);
  if (!repoRef) return state;

  const token = (await githubTokenForUser(run.userId)) ?? (await resolveInfraToken("github"));
  if (!token) {
    await emit({ kind: "warn", line: "-> workspace is empty and no github token can restore it — regenerating from the master prompt" });
    return state;
  }

  await emit({ kind: "info", line: "-> restoring the workspace from github (" + repoRef.owner + "/" + repoRef.name + ")" });
  const restored = await restoreWorkspaceFromGithub(token, repoRef, run.id);
  if (restored > 0) {
    await emit({ kind: "success", line: "-> restored " + restored + " files from the repo — iterating on the shipped code" });
    return { ...state, repo: repoRef, released: false };
  }
  await emit({ kind: "warn", line: "-> repo restore returned 0 files — regenerating from the master prompt" });
  return state;
}

async function stageDeploy(
  run: RunRow,
  state: PipelineState,
  master: MasterBuildPrompt,
  plan: ReturnType<typeof planOf>,
): Promise<PipelineState> {
  const emit = emitter(run.id, "deploy");
  await setRun(run.id, { status: "deploying", currentStage: "deploy" });
  await upsertAgent(run.id, "deploy", { status: "running", startedAt: new Date(), detail: "shipping to production" });

  // the zip is kept current so the download button is never stale
  const zip = zipWorkspace(run.id);
  await setRun(run.id, { zipPath: zip });

  const projectName =
    (master.productName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || "lastmile-app") +
    "-" + run.id.slice(0, 5);

  /* ── ship it ────────────────────────────────────────────────────────
     A remote build failure is a BUILD FAILURE, not a dead end: Vercel's own
     builder often disagrees with the local one (different cwd, fresh
     dependency tree, no inherited dev-server env). When that happens the
     deployment carries the real compiler output — so fetch it, hand it to the
     same fix loop the local gate uses, rebuild locally, and ship again.
     Only a non-build failure (auth, quota, permissions) ends the stage. */
  const maxRemoteFixes = Math.max(1, plan.codeVerifyRounds);
  let lastError = "";

  for (let attempt = 0; attempt <= maxRemoteFixes; attempt++) {
    try {
      const result = await deployToVercel(run.id, { projectName, env: {}, onLine: (l) => emit({ kind: "info", line: l }) });
      await emit({ kind: "url", line: "-> live at " + result.url });
      await setRun(run.id, { liveUrl: result.url });
      await upsertAgent(run.id, "deploy", { status: "done", provider: "vercel", detail: result.url, endedAt: new Date() });
      await releaseWorkspace(run, state, result.url, emit);
      return { ...state, deployedUrl: result.url, stage: "test" };
    } catch (vercelErr) {
      const vMsg = vercelErr instanceof Error ? vercelErr.message : String(vercelErr);
      lastError = vMsg;
      await emit({ kind: "warn", line: "-> vercel deploy failed: " + vMsg.slice(0, 200) });

      /* repairable: the remote builder produced compiler output we can fix */
      if (vercelErr instanceof RemoteBuildError && attempt < maxRemoteFixes) {
        const log = await fetchVercelBuildLog(vercelErr.deploymentId);
        await emit({ kind: "command", line: "$ lastmile logs — vercel build output" });
        for (const line of summarizeBuildLog(log).split("\n")) {
          await emit({ kind: "info", line: "-> " + line });
        }
        await emit({
          kind: "loop",
          line: `[LOOP] the remote builder rejected the code — sending its log to the coder (deploy round ${attempt + 1})`,
        });
        const patched = await patchBuildErrors(run.id, master, plan.id, log, emit);
        if (!patched) {
          await emit({ kind: "error", line: "-> the coder could not patch the vercel build errors" });
          break;
        }
        const rebuilt = await coderFinish(run.id, master, plan.id, emit, 2);
        if (!rebuilt.ok) {
          await emit({ kind: "error", line: "-> the local build gate failed after the vercel fix — not redeploying" });
          break;
        }
        await emit({ kind: "success", line: "-> local build gate passed — redeploying" });
        continue;
      }

      /* not repairable code (auth, quota, permission) — try the github+render path */
      if (state.repo) {
        try {
          await emit({ kind: "info", line: "-> falling back to render" });
          const result = await deployToRender(state.repo, { projectName, env: {}, onLine: (l) => emit({ kind: "info", line: l }) });
          await emit({ kind: "url", line: "-> live at " + result.url });
          await setRun(run.id, { liveUrl: result.url });
          await upsertAgent(run.id, "deploy", { status: "done", provider: "render", detail: result.url, endedAt: new Date() });
          await releaseWorkspace(run, state, result.url, emit);
          return { ...state, deployedUrl: result.url, stage: "test" };
        } catch (renderErr) {
          const rMsg = renderErr instanceof Error ? renderErr.message : String(renderErr);
          await emit({ kind: "error", line: "-> render fallback also failed: " + rMsg.slice(0, 200) });
        }
      }
      break;
    }
  }

  await upsertAgent(run.id, "deploy", { status: "failed", error: lastError.slice(0, 300), endedAt: new Date() });
  throw new Error("deploy failed — " + lastError.slice(0, 240));
}

/** The failing part of a remote build log: compiler errors, not install noise. */
function summarizeBuildLog(log: string): string {
  const lines = log.split(/\r?\n/);
  const hits = lines.filter((l) =>
    /error|failed|cannot|not found|Type error|Module not found|resolve|exited with|Failed to compile/i.test(l),
  );
  return (hits.length > 0 ? hits : lines).slice(-25).join("\n");
}

async function stageTest(run: RunRow, state: PipelineState, plan: ReturnType<typeof planOf>): Promise<PipelineState> {
  const emit = emitter(run.id, "test");
  const master = run.masterPrompt as unknown as MasterBuildPrompt;
  const liveUrl = state.deployedUrl;
  if (!liveUrl) throw new Error("test stage reached without a deployed URL");

  await setRun(run.id, { status: "testing", currentStage: "test" });
  await upsertAgent(run.id, "test", { status: "running", startedAt: new Date(), detail: "live QA against " + liveUrl.replace(/^https?:\/\//, "") });

  const report: TestReport = await testLive(run.id, liveUrl, master, plan.id, emit);

  // persist the real flow results — receipts, quality meter, and the loop
  // banner all read from these rows
  for (const [i, f] of report.flows.entries()) {
    await upsertFlow(run.id, {
      position: i,
      name: f.name,
      assertions: f.assertions,
      status: f.passed ? "pass" : "fail",
      attempts: f.attempts,
      durationMs: f.durationMs,
    });
  }

  const defects = report.flows.filter((f) => !f.passed);
  if (defects.length > 0 || report.consoleErrors.length > 4) {
    for (const d of defects) {
      await db.insert(runIssues).values({
        runId: run.id,
        iteration: state.iteration + 1,
        source: "test",
        severity: "major",
        title: d.name + " — " + (d.failure ?? "failed"),
        detail: "Flow failed on the live URL. " + (d.failure ?? ""),
        status: "open",
      });
    }
  }

  const scores = [...state.scores, report.score];
  await setRun(run.id, {
    qualityScore: report.score,
    iterations: state.iteration + 1,
    testReport: {
      consoleErrors: report.consoleErrors,
      screenshotCount: report.screenshots.length,
      flowsTotal: report.flows.length,
      flowsPassed: report.flows.filter((f) => f.passed).length,
      assertions: report.totalAssertions,
      score: report.score,
      browser: report.browser,
    },
  });
  await upsertAgent(run.id, "test", {
    status: report.score === 100 ? "done" : "failed",
    detail: report.flows.filter((f) => f.passed).length + "/" + report.flows.length + " flows · score " + report.score,
    endedAt: new Date(),
  });

  return { ...state, scores, stage: "test", deployedUrl: liveUrl };
}

/* ————————————————————————— the driver ————————————————————————— */

async function runPipeline(runId: string): Promise<void> {
  let run = await loadRun(runId);
  if (!run) return;
  if (run.killRequested) return abortForKill(run);
  if (!run.approvedAt) return; // nothing to do until the human approves
  if (run.status === "done" || run.status === "failed") return;

  const [user] = await db.select({ plan: users.plan }).from(users).where(eq(users.id, run.userId)).limit(1);
  const plan = planOf(user?.plan);
  let state = stateOf(run);

  await logRunEvent(runId, "orchestrator", BAND.post, "command", "$ lastmile pipeline — resuming at " + state.stage + " (iteration " + (state.iteration + 1) + " of " + plan.maxIterations + ")");

  try {
    while (true) {
      run = await loadRun(runId);
      if (!run) return;
      if (run.killRequested) return abortForKill(run);

      switch (state.stage) {
        case "prompt":
          state = await stagePrompt(run, state, plan);
          await saveState(runId, state);
          break;

        case "code": {
          state = await stageCode(run, state, plan);
          const master = (await loadRun(runId))!.masterPrompt as unknown as MasterBuildPrompt;
          state = await pushToGithub((await loadRun(runId))!, state, master, emitter(runId, "code"));
          await saveState(runId, state);
          break;
        }

        case "verify":
          state = await stageVerify(run, state, plan);
          await saveState(runId, state);
          break;

        case "deploy":
          state = await stageDeploy(run, state, run.masterPrompt as unknown as MasterBuildPrompt, plan);
          await saveState(runId, state);
          break;

        case "test": {
          state = await stageTest(run, state, plan);
          const score = state.scores[state.scores.length - 1];

          if (score === 100) {
            await saveState(runId, { ...state, stage: "test" });
            await ship(runId, state, plan);
            return;
          }

          if (state.iteration >= plan.maxIterations) {
            // honest cap: never fake a pass
            const open = await db
              .select({ title: runIssues.title })
              .from(runIssues)
              .where(and(eq(runIssues.runId, runId), eq(runIssues.status, "open")));
            await logRunEvent(runId, "test", BAND.post, "error", "[LOOP CAP] " + plan.maxIterations + " iterations reached — " + open.length + " issue(s) still open: " + open.map((i) => i.title).slice(0, 5).join("; "));
            await setRun(runId, {
              status: "failed",
              error: "Quality loop hit the cap of " + plan.maxIterations + " iterations at " + score + "/100. Open issues: " + open.map((i) => i.title).slice(0, 6).join(" · "),
              completedAt: new Date(),
            });
            await upsertAgent(runId, "orchestrator", { status: "failed", detail: "quality loop capped at " + score + "/100", endedAt: new Date() });
            return;
          }

          // the quality loop: back to the coder, then verify → deploy → test again
          const nextIteration = state.iteration + 1;
          await logRunEvent(runId, "test", BAND.post, "warn", "[LOOP] " + score + "/100 — sending defects back for fixes (iteration " + (nextIteration + 1) + " of " + (plan.maxIterations + 1) + ")");
          await setRun(runId, { status: "fixing", currentStage: "code", iterations: nextIteration });
          state = { ...state, iteration: nextIteration, stage: "code" };
          await saveState(runId, state);

          const master = (await loadRun(runId))!.masterPrompt as unknown as MasterBuildPrompt;
          /* a released workspace has no code to patch — refill from the repo
             before the fix round runs (the quality loop bypasses stageCode) */
          state = await ensureWorkspaceReady((await loadRun(runId))!, state, emitter(runId, "code"));
          const openIssues = await db
            .select()
            .from(runIssues)
            .where(and(eq(runIssues.runId, runId), eq(runIssues.status, "open")));
          const patched = await patchForIssues(runId, master, plan.id, openIssues.map((i) => ({ title: i.title, detail: i.detail, severity: i.severity, source: i.source })), emitter(runId, "code"));
          if (!patched) throw new Error("the coder could not produce fixes for the open issues");

          // mark the fixed issues, rebuild, redeploy, retest
          await db.update(runIssues).set({ status: "fixed" }).where(and(eq(runIssues.runId, runId), eq(runIssues.status, "open")));
          const buildResult = await coderFinish(runId, master, plan.id, emitter(runId, "code"), 2);
          if (!buildResult.ok) throw new Error(buildResult.error ?? "the fixed build failed");
          state.buildOk = true;
          state = await stageDeploy((await loadRun(runId))!, state, master, plan);
          await saveState(runId, state);
          break;
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logRunEvent(runId, "orchestrator", BAND.post, "error", "[PIPELINE FAILED] " + message.slice(0, 400));
    await setRun(runId, { status: "failed", error: message.slice(0, 400), completedAt: new Date() });
    await upsertAgent(runId, "orchestrator", { status: "failed", error: message.slice(0, 300), endedAt: new Date() });
  }
}

async function ship(runId: string, state: PipelineState, plan: ReturnType<typeof planOf>): Promise<void> {
  const run = await loadRun(runId);
  if (!run) return;
  const zip = zipWorkspace(runId);
  await logRunEvent(runId, "orchestrator", BAND.post, "success", "[SHIP] quality score 100/100 after " + (state.iteration + 1) + " iteration(s) — shipping");
  await upsertAgent(runId, "orchestrator", { status: "done", detail: "shipped at 100/100 · plan: " + plan.id, endedAt: new Date() });
  await setRun(runId, {
    status: "done",
    currentStage: "done",
    qualityScore: 100,
    zipPath: zip,
    completedAt: new Date(),
  });
}

async function abortForKill(run: RunRow): Promise<void> {
  await logRunEvent(run.id, "orchestrator", BAND.post, "error", "[KILLED] the run was stopped by an operator");
  await setRun(run.id, { status: "failed", error: "Stopped by an operator via the kill switch.", completedAt: new Date(), killRequested: false });
  await upsertAgent(run.id, "orchestrator", { status: "failed", error: "killed by operator", endedAt: new Date() });
}

/* ————————————————————————— job lifecycle ————————————————————————— */

/* Same guard-set pattern as the research job: fire-and-forget, module-scoped,
   resumed by the state route's watchdog when the process died mid-run. */
const activeJobs = ((globalThis as unknown as { __lmPipelineJobs?: Set<string> }).__lmPipelineJobs ??= new Set<string>());

export function isPipelineActive(runId: string): boolean {
  return activeJobs.has(runId);
}

export function kickPipeline(runId: string, userId: string | null): void {
  if (activeJobs.has(runId)) return;
  activeJobs.add(runId);
  // the run's owner scopes every model call inside: their own providers first,
  // then the platform's, then the env chain
  void runAsUser(userId, async () => {
    try {
      await runPipeline(runId);
    } catch (err) {
      console.error("[pipeline] job crashed for run " + runId, err);
      await db
        .update(runs)
        .set({ status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 400) })
        .where(eq(runs.id, runId))
        .catch(() => undefined);
    } finally {
      activeJobs.delete(runId);
    }
  });
}

/** Retry a capped/failed run from its last good stage. Never fake progress. */
export function retryRun(runId: string): void {
  void (async () => {
    const run = await loadRun(runId);
    if (!run) return;
    const state = stateOf(run);
    const resume = state.deployedUrl ? "test" : state.buildOk ? "verify" : "code";
    await db
      .update(runIssues)
      .set({ status: "open" })
      .where(and(eq(runIssues.runId, runId), eq(runIssues.status, "fixed")));
    await logRunEvent(runId, "orchestrator", BAND.post, "command", "$ lastmile retry — resuming from " + resume);
    await setRun(runId, {
      status: resume === "test" ? "testing" : resume === "verify" ? "reviewing" : "coding",
      currentStage: resume,
      error: null,
      killRequested: false,
      pipelineState: { ...state, stage: resume },
    });
    kickPipeline(runId, run.userId);
  })();
}
