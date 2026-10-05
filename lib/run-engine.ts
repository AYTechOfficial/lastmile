import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "./db";
import { agentRuns, runEvents, runFlows, runIssues, runs, users } from "./schema";
import type { PlanId } from "./platform/settings";
import { research, type ResearchBrief } from "./agents/research";
import { fallbackSpec, specFromBrief, type ProductSpec } from "./agents/spec";
import { isPipelineActive, kickPipeline } from "./pipeline/orchestrator";
import { runAsUser } from "./ai/context";

/* The pipeline engine.

   Two engines live behind this module:

     stub  — the original deterministic, time-driven timeline. Every event has
             a planned offset from its phase anchor, so the dashboard was real
             and testable before a single agent existed. Still used for the
             build/deploy/verify stages, and for runs created before the agent
             engine landed.

     live  — the pre-approval stages (research, spec) are performed by real
             agents, which write their own events as they work. Nothing about
             their timing is fictional: the timestamps in the feed are when the
             search actually ran and the model actually answered.

   Event sequence bands keep the two from colliding:
     1    – 999    research band (agent output, or the stub's planned pre-phase)
     1000 – 1999   checkpoint band (approval / change-request markers)
     2000 – 2999   post-approval band (build → deploy → verify)               */

export const BAND = {
  research: { from: 1, to: 999 },
  checkpoint: { from: 1000, to: 1999 },
  post: { from: 2000, to: 2999 },
} as const;

export type Band = (typeof BAND)[keyof typeof BAND];

/* ————————————————————————— plan types ————————————————————————— */

export type RunPlanEvent = {
  seq: number;
  at: number; // seconds from the phase anchor
  stage: string;
  kind: "info" | "command" | "success" | "warn" | "error" | "flow" | "url";
  line: string;
  flow?: {
    position: number;
    name: string;
    assertions: number;
    status: "pass" | "fixed";
    attempts: number;
    durationMs: number;
  };
};

export type RunPlanStage = {
  stage: string;
  status: string;
  from: number;
  to: number;
  tokensEnd: number;
  costCentsEnd: number;
};

export type RunPlan = {
  slug: string;
  pre: RunPlanEvent[];
  post: RunPlanEvent[];
  preStages: RunPlanStage[];
  postStages: RunPlanStage[];
  repoUrl: string;
  liveUrl: string;
  preEnd: number;
  postEnd: number;
};

function slugify(sentence: string): string {
  const stop = new Set(["a", "an", "the", "for", "with", "of", "to", "and", "in", "on", "my"]);
  const words = sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w && !stop.has(w));
  return words.slice(0, 3).join("-") || "app";
}

function titleCase(sentence: string): string {
  const clean = sentence.trim().replace(/\.$/, "");
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Human title for a one-sentence run, before any agent has seen it. */
export function titleFromSentence(sentence: string): string {
  return titleCase(sentence);
}

/* ——————————— the post-approval timeline (still stubbed) ——————————— */

export function buildRunPlan(sentence: string): RunPlan {
  const clean = sentence.trim().replace(/\.$/, "");
  const slug = slugify(clean);
  const repoUrl = "github.com/lastmile-builds/" + slug;
  const liveUrl = slug + ".vercel.app";

  const pre: RunPlanEvent[] = [
    { seq: 1, at: 0, stage: "research", kind: "command", line: '$ lastmile run "' + clean.toLowerCase() + '"' },
    { seq: 2, at: 1.2, stage: "research", kind: "info", line: "-> spinning up research agent - web + competitor sweep" },
    { seq: 3, at: 4.5, stage: "research", kind: "info", line: "-> reading 14 sources - 6 comparable products" },
    { seq: 4, at: 8.4, stage: "research", kind: "info", line: "-> pricing pages scanned - positioning mapped" },
    { seq: 5, at: 11.5, stage: "research", kind: "success", line: "-> research done - market gap: simplicity beats feature lists here" },
    { seq: 6, at: 13.5, stage: "spec", kind: "info", line: "-> spec agent - drafting from research notes" },
    { seq: 7, at: 17.2, stage: "spec", kind: "info", line: "-> stack chosen: Next.js 15 - Postgres - Tailwind - Auth.js" },
    { seq: 8, at: 21.0, stage: "spec", kind: "info", line: "-> 4 core flows - 12 acceptance criteria written" },
    { seq: 9, at: 25.0, stage: "spec", kind: "success", line: "-> spec ready - waiting for your approval" },
  ];

  const post: RunPlanEvent[] = [
    { seq: 2000, at: 0.8, stage: "build", kind: "info", line: "-> scaffolding app router structure - 24 files" },
    { seq: 2001, at: 5.5, stage: "build", kind: "info", line: "-> implementing auth, core entity + dashboard shell" },
    { seq: 2002, at: 11.0, stage: "build", kind: "info", line: "-> wiring Postgres schema - migrations clean" },
    { seq: 2003, at: 16.5, stage: "build", kind: "info", line: "-> writing smoke tests for 4 core flows" },
    { seq: 2004, at: 22.0, stage: "build", kind: "success", line: "-> build 41 files - next.js 15 - github push ok (" + repoUrl + ")" },
    { seq: 2005, at: 27.5, stage: "deploy", kind: "info", line: "-> deploy vercel - provisioning project..." },
    { seq: 2006, at: 33.0, stage: "deploy", kind: "url", line: "-> live in 38s - https://" + liveUrl },
    { seq: 2007, at: 36.0, stage: "verify", kind: "info", line: "-> testing live app against 4 core flows - chromium" },
    {
      seq: 2008, at: 40.0, stage: "verify", kind: "flow",
      line: "[PASS] Signup -> login -> dashboard - 4 assertions - 1.9s",
      flow: { position: 0, name: "Signup -> login -> dashboard", assertions: 4, status: "pass", attempts: 1, durationMs: 1900 },
    },
    {
      seq: 2009, at: 44.0, stage: "verify", kind: "flow",
      line: "[PASS] Create record - persists on reload - 6 assertions - 2.4s",
      flow: { position: 1, name: "Create record - persists on reload", assertions: 6, status: "pass", attempts: 1, durationMs: 2400 },
    },
    { seq: 2010, at: 47.5, stage: "verify", kind: "warn", line: "[FAIL] Invite teammate by email - attempt 1 (selector drift)" },
    { seq: 2011, at: 51.0, stage: "verify", kind: "info", line: "-> auto-fix: re-anchoring selector to [data-testid=invite-row]" },
    {
      seq: 2012, at: 55.0, stage: "verify", kind: "flow",
      line: "[FIXED] Invite teammate by email - 5 assertions - attempt 2",
      flow: { position: 2, name: "Invite teammate by email", assertions: 5, status: "fixed", attempts: 2, durationMs: 134000 },
    },
    {
      seq: 2013, at: 58.5, stage: "verify", kind: "flow",
      line: "[PASS] Payment stub renders in checkout - 3 assertions - 0.8s",
      flow: { position: 3, name: "Payment stub renders in checkout", assertions: 3, status: "pass", attempts: 1, durationMs: 800 },
    },
    { seq: 2014, at: 61.0, stage: "verify", kind: "success", line: "-> 4/4 core flows green - 12 screenshots - trace - logs attached" },
    { seq: 2015, at: 62.5, stage: "verify", kind: "success", line: "[VERIFIED] link ready: https://" + liveUrl },
  ];

  const preStages: RunPlanStage[] = [
    { stage: "research", status: "researching", from: 0, to: 13, tokensEnd: 62000, costCentsEnd: 28 },
    { stage: "spec", status: "spec", from: 13, to: 26, tokensEnd: 118000, costCentsEnd: 54 },
  ];
  const postStages: RunPlanStage[] = [
    { stage: "build", status: "building", from: 0, to: 26, tokensEnd: 328000, costCentsEnd: 148 },
    { stage: "deploy", status: "deploying", from: 26, to: 36, tokensEnd: 341000, costCentsEnd: 153 },
    { stage: "verify", status: "verifying", from: 36, to: 63, tokensEnd: 412000, costCentsEnd: 187 },
  ];

  return { slug, pre, post, preStages, postStages, repoUrl, liveUrl, preEnd: 26, postEnd: 63 };
}

/* ————————————————————————— event writes ————————————————————————— */

type RunRow = typeof runs.$inferSelect;

/** Next free sequence number inside a band. */
async function nextSeq(runId: string, band: Band): Promise<number> {
  const [row] = await db
    .select({ seq: runEvents.seq })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gte(runEvents.seq, band.from), lte(runEvents.seq, band.to)))
    .orderBy(desc(runEvents.seq))
    .limit(1);
  return row ? row.seq + 1 : band.from;
}

/** Append one event, allocating the sequence number. Serialized per run. */
export async function logRunEvent(
  runId: string,
  stage: string,
  band: Band,
  kind: RunPlanEvent["kind"],
  line: string,
): Promise<void> {
  const seq = await nextSeq(runId, band);
  await db.insert(runEvents).values({ runId, seq, stage, kind, line, at: new Date() }).onConflictDoNothing();
}

async function upsertAgent(
  runId: string,
  agent: string,
  values: Partial<typeof agentRuns.$inferInsert>,
): Promise<void> {
  await db
    .insert(agentRuns)
    .values({ runId, agent, ...values })
    .onConflictDoUpdate({
      target: [agentRuns.runId, agentRuns.agent],
      set: { ...values },
    });
}

/* ————————————————————— the live research job ————————————————————— */

/* Runs in-process, fire-and-forget from the server action and from the state
   route's watchdog. The guard set is module-scoped, so a dev-server restart
   simply means the watchdog picks the run back up — the job body is a pure
   function of runId, which is exactly the shape a real queue worker needs. */
const active = ((globalThis as unknown as { __lmJobs?: Set<string> }).__lmJobs ??= new Set<string>());

export function isJobActive(runId: string): boolean {
  return active.has(runId);
}

async function runPreApprovalStages(runId: string): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) return;
  if (run.status !== "queued" && run.status !== "researching" && run.status !== "spec") return;

  const plan = run.plan as unknown as RunPlan;
  const startedAt = run.startedAt ?? new Date();

  await db
    .update(runs)
    .set({ status: "researching", currentStage: "research", startedAt })
    .where(eq(runs.id, runId));

  /* 01 — research -------------------------------------------------------- */

  let brief = run.research as unknown as ResearchBrief | null;

  // a re-kicked job must not pay for the same research twice
  if (!brief) {
    await upsertAgent(runId, "research", {
      status: "running",
      startedAt: new Date(),
      detail: "planning queries, searching the live web",
    });

    try {
      // research synthesizes on the model chain this run's plan is allowed to use
      const [u] = await db.select({ plan: users.plan }).from(users).where(eq(users.id, run.userId)).limit(1);
      const planId: PlanId = u?.plan === "pro" ? "pro" : "free";
      const outcome = await research(run.title, planId, (event) =>
        logRunEvent(runId, "research", BAND.research, event.kind, event.line),
      );
      brief = outcome.brief;

      await upsertAgent(runId, "research", {
        status: "done",
        provider: brief.providerLabel,
        model: brief.model,
        tokens: brief.tokens,
        elapsedMs: brief.elapsedMs,
        detail:
          brief.quality === "full"
            ? `${brief.competitors.length} competitors · ${brief.sources.length} sources`
            : `${brief.quality} brief · ${brief.sources.length} sources`,
        endedAt: new Date(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logRunEvent(runId, "research", BAND.research, "error", "-> research agent failed - " + message.slice(0, 200));
      await upsertAgent(runId, "research", { status: "failed", error: message.slice(0, 400), endedAt: new Date() });
      await db.update(runs).set({ status: "failed", error: message.slice(0, 400) }).where(eq(runs.id, runId));
      return;
    }
  } else {
    await upsertAgent(runId, "research", {
      status: "done",
      provider: brief.providerLabel,
      model: brief.model,
      tokens: brief.tokens,
      elapsedMs: brief.elapsedMs,
      detail: "resumed from stored brief",
      endedAt: new Date(),
    });
  }

  /* 02 — spec ------------------------------------------------------------ */

  await db.update(runs).set({ status: "spec", currentStage: "spec" }).where(eq(runs.id, runId));
  await upsertAgent(runId, "spec", { status: "running", startedAt: new Date(), detail: "deriving build spec from the brief" });

  await logRunEvent(runId, "spec", BAND.research, "info", "-> spec agent - drafting from research notes");

  const spec: ProductSpec = brief
    ? specFromBrief(brief, run.specVariant)
    : fallbackSpec(run.title, run.specVariant);

  await logRunEvent(
    runId,
    "spec",
    BAND.research,
    "info",
    "-> stack chosen: " + spec.stack.slice(0, 4).join(" - "),
  );
  await logRunEvent(
    runId,
    "spec",
    BAND.research,
    "info",
    `-> ${spec.flows.length} core flows - ${spec.acceptance} acceptance criteria written`,
  );
  await logRunEvent(
    runId,
    "spec",
    BAND.research,
    "success",
    "-> spec v" + spec.variant + " ready - waiting for your approval",
  );

  const tokens = brief?.tokens ?? 0;
  await db
    .update(runs)
    .set({
      status: "awaiting_approval",
      currentStage: "checkpoint",
      spec,
      research: brief ?? null,
      tokens,
      error: null,
      plan: { ...plan, repoUrl: "github.com/lastmile-builds/" + plan.slug, liveUrl: plan.liveUrl },
    })
    .where(eq(runs.id, runId));

  await upsertAgent(runId, "spec", {
    status: "done",
    detail: `${spec.flows.length} flows · ${spec.acceptance} assertions`,
    endedAt: new Date(),
  });
}

/** Fire-and-forget the pre-approval stages. Safe to call repeatedly. */
export function kick(runId: string, userId: string | null): void {
  if (active.has(runId)) return;
  active.add(runId);
  // scope the job to the run's owner so research/spec resolve their keys first
  void runAsUser(userId, async () => {
    try {
      await runPreApprovalStages(runId);
    } catch (err) {
      console.error("[engine] job crashed for run " + runId, err);
      await db
        .update(runs)
        .set({ status: "failed", error: err instanceof Error ? err.message.slice(0, 400) : String(err) })
        .where(eq(runs.id, runId))
        .catch(() => undefined);
    } finally {
      active.delete(runId);
    }
  });
}

/* ————————————————————— timeline materialization ————————————————————— */

function stageAt(stages: RunPlanStage[], elapsed: number): RunPlanStage {
  let current = stages[0];
  for (const s of stages) {
    if (elapsed >= s.from) current = s;
  }
  return current;
}

function progressTokens(stages: RunPlanStage[], elapsed: number): { tokens: number; costCents: number } {
  const s = stageAt(stages, elapsed);
  const span = Math.max(0.001, s.to - s.from);
  const frac = Math.min(1, Math.max(0, (elapsed - s.from) / span));
  const prev = stages[stages.indexOf(s) - 1];
  const prevTokens = prev ? prev.tokensEnd : 0;
  const prevCost = prev ? prev.costCentsEnd : 0;
  return {
    tokens: Math.round(prevTokens + (s.tokensEnd - prevTokens) * frac),
    costCents: Math.round(prevCost + (s.costCentsEnd - prevCost) * frac),
  };
}

/* Writes every planned event whose time has come. Deliberately batched: a
   poll used to fire one query per flow and per URL event, which dominated the
   round-trip cost of the whole endpoint. Now it is at most three statements. */
async function materialize(run: RunRow, anchorMs: number, events: RunPlanEvent[], band: Band): Promise<void> {
  const [row] = await db
    .select({ seq: runEvents.seq })
    .from(runEvents)
    .where(and(eq(runEvents.runId, run.id), gte(runEvents.seq, band.from), lte(runEvents.seq, band.to)))
    .orderBy(desc(runEvents.seq))
    .limit(1);
  const max = row?.seq ?? band.from - 1;

  const now = Date.now();
  const due = events.filter((e) => e.seq > max && e.at * 1000 <= now - anchorMs);
  if (due.length === 0) return;

  await db
    .insert(runEvents)
    .values(
      due.map((e) => ({
        runId: run.id,
        seq: e.seq,
        stage: e.stage,
        kind: e.kind,
        line: e.line,
        at: new Date(anchorMs + e.at * 1000),
      })),
    )
    .onConflictDoNothing();

  const flowEvents = due.filter((e) => e.kind === "flow" && e.flow).map((e) => e.flow!);
  if (flowEvents.length > 0) {
    await db
      .insert(runFlows)
      .values(
        flowEvents.map((f) => ({
          runId: run.id,
          position: f.position,
          name: f.name,
          assertions: f.assertions,
          status: f.status,
          attempts: f.attempts,
          durationMs: f.durationMs,
        })),
      )
      .onConflictDoUpdate({
        target: [runFlows.runId, runFlows.position],
        set: {
          name: sql`excluded.name`,
          assertions: sql`excluded.assertions`,
          status: sql`excluded.status`,
          attempts: sql`excluded.attempts`,
          durationMs: sql`excluded.duration_ms`,
        },
      });
  }

  if (due.some((e) => e.kind === "url")) {
    const p = run.plan as unknown as RunPlan;
    await db.update(runs).set({ liveUrl: "https://" + p.liveUrl }).where(eq(runs.id, run.id));
  }
}

/* ————————————————————————— advancing ————————————————————————— */

/** Advance a run to its true state for now and persist it. Scoped by userId. */
export async function advanceRun(runId: string, userId: string): Promise<RunRow | null> {
  let [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, userId)))
    .limit(1);
  if (!run) return null;
  if (run.status === "done" || run.status === "failed") return run;

  const plan = run.plan as unknown as RunPlan;
  const now = Date.now();
  const live = run.engine === "live";

  if (run.status === "queued") {
    if (live) {
      kick(run.id, run.userId); // the agent owns the pre-approval stages
      return { ...run, status: "researching", currentStage: "research" };
    }
    await db
      .update(runs)
      .set({ status: "researching", currentStage: "research", startedAt: new Date(now) })
      .where(eq(runs.id, run.id));
    run = { ...run, status: "researching", startedAt: new Date(now) };
  }

  if (run.status === "awaiting_approval") return run;

  if (!run.approvedAt) {
    if (live) {
      // the job is authoritative here; this branch only recovers a run whose
      // process died mid-flight (dev restart, crash) so it never hangs
      const anchor = (run.startedAt ?? run.createdAt).getTime();
      const stalled = now - anchor > 180_000;
      if (stalled && !isJobActive(run.id) && !run.research) {
        kick(run.id, run.userId);
      }
      return run;
    }

    const anchor = (run.startedAt ?? new Date(now)).getTime();
    const elapsed = (now - anchor) / 1000;
    await materialize(run, anchor, plan.pre, BAND.research);

    if (elapsed >= plan.preEnd) {
      const [updated] = await db
        .update(runs)
        .set({
          status: "awaiting_approval",
          currentStage: "checkpoint",
          tokens: plan.preStages[plan.preStages.length - 1].tokensEnd,
          costCents: plan.preStages[plan.preStages.length - 1].costCentsEnd,
        })
        .where(eq(runs.id, run.id))
        .returning();
      return updated ?? run;
    }

    const s = stageAt(plan.preStages, elapsed);
    const p = progressTokens(plan.preStages, elapsed);
    await db
      .update(runs)
      .set({ status: s.status, currentStage: s.stage, tokens: p.tokens, costCents: p.costCents })
      .where(eq(runs.id, run.id));
    return { ...run, status: s.status, currentStage: s.stage, tokens: p.tokens, costCents: p.costCents };
  }

  /* post-approval — the orchestrator owns everything from here on. This branch
     only recovers a run whose job died with the process (dev restart, crash):
     if the run is still active and no pipeline job holds it, re-kick. The
     orchestrator resumes from runs.pipeline_state instead of starting over. */
  if (live) {
    if (!isPipelineActive(run.id) && !run.killRequested) {
      kickPipeline(run.id, run.userId);
    }
    return run;
  }

  const anchor = run.approvedAt.getTime();
  const elapsed = (now - anchor) / 1000;
  await materialize(run, anchor, plan.post, BAND.post);

  if (elapsed >= plan.postEnd) {
    const [updated] = await db
      .update(runs)
      .set({
        status: "done",
        currentStage: "done",
        repoUrl: "https://" + plan.repoUrl,
        liveUrl: "https://" + plan.liveUrl,
        completedAt: new Date(now),
        // live runs on free tiers: no dollar cost is invented for them
        ...(live ? {} : { tokens: plan.postStages[plan.postStages.length - 1].tokensEnd, costCents: plan.postStages[plan.postStages.length - 1].costCentsEnd }),
      })
      .where(eq(runs.id, run.id))
      .returning();
    return updated ?? run;
  }

  const s = stageAt(plan.postStages, elapsed);
  const patch: Partial<typeof runs.$inferInsert> = { status: s.status, currentStage: s.stage };
  if (!live) {
    const p = progressTokens(plan.postStages, elapsed);
    patch.tokens = p.tokens;
    patch.costCents = p.costCents;
  }
  await db.update(runs).set(patch).where(eq(runs.id, run.id));
  return { ...run, ...patch } as RunRow;
}

/* ————————————————————————— reads ————————————————————————— */

/** Full state for the live UI. */
export async function getRunState(runId: string, userId: string) {
  const run = await advanceRun(runId, userId);
  if (!run) return null;
  const [events, flows, agents, issues] = await Promise.all([
    db.select().from(runEvents).where(eq(runEvents.runId, run.id)).orderBy(asc(runEvents.seq)),
    db.select().from(runFlows).where(eq(runFlows.runId, run.id)).orderBy(asc(runFlows.position)),
    db.select().from(agentRuns).where(eq(agentRuns.runId, run.id)).orderBy(asc(agentRuns.startedAt)),
    db.select().from(runIssues).where(eq(runIssues.runId, run.id)).orderBy(asc(runIssues.createdAt)),
  ]);
  return { run, events, flows, agents, issues };
}

/** The workflow a run walks, in order — used by the stage tracker and chevrons. */
export const STAGES = ["research", "spec", "checkpoint", "build", "deploy", "verify"] as const;
export type StageId = (typeof STAGES)[number];
