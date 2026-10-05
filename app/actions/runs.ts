"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, count, eq, gte, notInArray } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runs, users } from "@/lib/schema";
import {
  BAND,
  buildRunPlan,
  kick,
  logRunEvent,
  titleFromSentence,
} from "@/lib/run-engine";
import { kickPipeline, retryRun } from "@/lib/pipeline/orchestrator";
import { countTodaysRuns, planOf } from "@/lib/plans";
import type { ResearchBrief } from "@/lib/agents/research";
import { fallbackSpec, specFromBrief } from "@/lib/agents/spec";

export type CreateRunState = { error?: string };

export async function createRunAction(
  _prev: CreateRunState,
  formData: FormData,
): Promise<CreateRunState> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const sentence = String(formData.get("sentence") ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (sentence.length < 10 || sentence.length > 200) {
    return { error: "Describe your product in 10-200 characters." };
  }

  const [user] = await db.select({ plan: users.plan }).from(users).where(eq(users.id, session.user.id)).limit(1);
  const tier = planOf(user?.plan);

  const today = await db
    .select({ createdAt: runs.createdAt })
    .from(runs)
    .where(and(eq(runs.userId, session.user.id), gte(runs.createdAt, startOfUtcDay())));
  if (countTodaysRuns(today) >= tier.dailyBuilds) {
    return {
      error:
        tier.id === "free"
          ? "Daily limit reached on the " + tier.label + " plan (" + tier.dailyBuilds + " builds). The counter resets at midnight UTC."
          : "Daily limit reached on the " + tier.label + " plan (" + tier.dailyBuilds + " builds). Resets at midnight UTC.",
    };
  }

  const [{ value }] = await db
    .select({ value: count() })
    .from(runs)
    .where(eq(runs.userId, session.user.id));
  const runNumber = Number(value) + 1;

  const plan = buildRunPlan(sentence);
  const [run] = await db
    .insert(runs)
    .values({
      userId: session.user.id,
      runNumber,
      title: titleFromSentence(sentence),
      status: "queued",
      currentStage: "research",
      engine: "live",
      plan,
      startedAt: new Date(),
    })
    .returning();

  // the Research Agent takes it from here; the dashboard streams its work live
  kick(run.id, run.userId);

  revalidatePath("/dashboard");
  redirect("/dashboard/runs/" + run.id);
}

export async function approveSpecAction(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const runId = String(formData.get("runId") ?? "");

  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, session.user.id)))
    .limit(1);
  if (!run || run.status !== "awaiting_approval") return;

  const now = new Date();

  await logRunEvent(
    run.id,
    "checkpoint",
    BAND.checkpoint,
    "command",
    "APPROVED - spec approved by you, handing off to the orchestrator",
  );

  await db
    .update(runs)
    .set({ approvedAt: now, status: "prompting", currentStage: "prompt" })
    .where(eq(runs.id, run.id));

  // the orchestrator owns everything after this point (live runs only —
  // legacy stub runs keep their planned timeline)
  if (run.engine === "live") kickPipeline(run.id, run.userId);

  revalidatePath("/dashboard/runs/" + run.id);
}

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** User-facing retry after a capped or failed quality loop. */
export async function retryRunAction(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const runId = String(formData.get("runId") ?? "");
  const [run] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, session.user.id)))
    .limit(1);
  if (!run) return;
  retryRun(run.id);
  revalidatePath("/dashboard/runs/" + run.id);
}

/** User-facing stop for their own run — only meaningful while it executes. */
export async function killRunAction(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const runId = String(formData.get("runId") ?? "");
  await db
    .update(runs)
    .set({ killRequested: true })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.userId, session.user.id),
        // never let a stop flag terminate an idle or finished run
        notInArray(runs.status, ["done", "failed", "awaiting_approval", "queued"]),
      ),
    );
  revalidatePath("/dashboard/runs/" + runId);
}

export async function requestChangesAction(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const runId = String(formData.get("runId") ?? "");
  const note = String(formData.get("note") ?? "").trim().slice(0, 400);

  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, session.user.id)))
    .limit(1);
  if (!run || run.status !== "awaiting_approval") return;

  // a change request revises the spec, never the research underneath it
  const brief = run.research as unknown as ResearchBrief | null;
  const variant = run.specVariant + 1;
  const revised = brief ? specFromBrief(brief, variant) : fallbackSpec(run.title, variant);

  await logRunEvent(
    run.id,
    "checkpoint",
    BAND.checkpoint,
    "warn",
    "CHANGES REQUESTED" + (note ? " - " + note : ""),
  );
  await logRunEvent(
    run.id,
    "checkpoint",
    BAND.checkpoint,
    "success",
    "-> spec v" + variant + " ready - re-review the update",
  );

  await db
    .update(runs)
    .set({
      spec: revised,
      specVariant: variant,
      approvedAt: null,
      status: "awaiting_approval",
      currentStage: "checkpoint",
    })
    .where(eq(runs.id, run.id));

  revalidatePath("/dashboard/runs/" + run.id);
}
