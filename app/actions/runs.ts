"use server";

import { and, asc, count, eq, gte, notInArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runs, users } from "@/lib/schema";
import { cancelQueuedForRun, enqueue } from "@/lib/queue";
import { planOf } from "@/lib/plans";
import { logEvent } from "@/lib/events";
import { dispatchRunner } from "@/lib/platform/runner";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeSentence, slugify, titleFrom, SENTENCE_MAX, SENTENCE_MIN } from "@/lib/slug";

/* Run actions — the only place the dashboard touches the pipeline.

   Every one of these writes rows and wakes a runner. None of them runs an
   agent, spawns a process, or waits on a model. That is the whole point: the
   request returns in milliseconds whether the runner is awake or not, and a
   platform that recycles instances cannot interrupt work it never owned.

   The queue is the source of truth. If the runner fails to wake, the scheduled
   poll picks the job up; a dispatch failure degrades latency, never correctness. */

export type CreateRunState = { error?: string };

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function createRunAction(
  _prev: CreateRunState,
  formData: FormData,
): Promise<CreateRunState> {
  const session = await auth();
  if (!session?.user?.id) return { error: "Sign in to start a run." };

  const sentence = normalizeSentence(String(formData.get("sentence") ?? ""));
  if (sentence.length < SENTENCE_MIN || sentence.length > SENTENCE_MAX) {
    return { error: `Describe your product in ${SENTENCE_MIN}-${SENTENCE_MAX} characters.` };
  }

  /* One sentence is a cheap thing to spam, and every run costs real model
     tokens, so creation is limited per user. */
  const limited = await rateLimit(`run:${session.user.id}`, 10, 60_000);
  if (!limited.ok) {
    return { error: "That is a lot of runs at once. Give it a minute." };
  }

  const [user] = await db
    .select({ plan: users.plan })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  const tier = planOf(user?.plan);

  const todays = await db
    .select({ n: count() })
    .from(runs)
    .where(and(eq(runs.userId, session.user.id), gte(runs.createdAt, startOfUtcDay())));

  const used = Number(todays[0]?.n ?? 0);
  if (used >= tier.dailyBuilds) {
    return {
      error: `Daily limit reached on the ${tier.label} plan (${tier.dailyBuilds} builds). Resets at midnight UTC.`,
    };
  }

  const [{ value }] = await db
    .select({ value: count() })
    .from(runs)
    .where(eq(runs.userId, session.user.id));

  const now = new Date();
  const [run] = await db
    .insert(runs)
    .values({
      userId: session.user.id,
      runNumber: Number(value) + 1,
      sentence,
      title: titleFrom(sentence),
      slug: slugify(sentence),
      /* Queued, not running: the runner decides when it starts, and this stays
         truthful if the runner is cold. */
      status: "queued",
      currentStage: "research",
      planId: tier.id,
      startedAt: now,
    })
    .returning();

  await logEvent(
    run.id,
    "research",
    "command",
    `$ lastmile run #${run.runNumber} — "${sentence}"`,
  );

  const job = await enqueue({ runId: run.id, kind: "research" });

  /* Wake a runner for this specific job. Best effort — see the module comment. */
  await dispatchRunner({ jobId: job.id });

  revalidatePath("/dashboard");
  redirect("/dashboard/runs/" + run.id);
}

/** The human checkpoint, cleared. Only now does the coding agent get to run. */
export async function approveSpecAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) return;

  const runId = String(formData.get("runId") ?? "");
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, session.user.id)))
    .limit(1);

  if (!run || run.status !== "awaiting_approval") return;

  await logEvent(
    run.id,
    "checkpoint",
    "success",
    "APPROVED — the master prompt is cleared, handing off to the coding agent",
  );

  await db
    .update(runs)
    .set({
      status: "queued",
      currentStage: "code",
      approvedAt: new Date(),
      error: null,
    })
    .where(eq(runs.id, run.id));

  const job = await enqueue({ runId: run.id, kind: "code", payload: { firstPass: true } });
  await dispatchRunner({ jobId: job.id });

  revalidatePath("/dashboard/runs/" + run.id);
}

/** Changes requested at the checkpoint.

    This queues a Prompt Agent rebuild rather than editing anything here — the
    prompt is written by a model over the research, so rebuilding it is runner
    work. Research is deliberately not re-run: the evidence did not change, the
    interpretation did. */
export async function requestChangesAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) return;

  const runId = String(formData.get("runId") ?? "");
  const note = String(formData.get("note") ?? "").trim().slice(0, 400);

  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, session.user.id)))
    .limit(1);

  if (!run || run.status !== "awaiting_approval") return;

  const variant = run.specVariant + 1;

  await logEvent(
    run.id,
    "checkpoint",
    "warn",
    "CHANGES REQUESTED" + (note ? " — " + note : "") + ` — rebuilding the master prompt (v${variant})`,
  );

  await db
    .update(runs)
    .set({
      status: "queued",
      currentStage: "prompt",
      specVariant: variant,
      approvedAt: null,
    })
    .where(eq(runs.id, run.id));

  const job = await enqueue({
    runId: run.id,
    kind: "prompt",
    payload: { variant, guidance: note },
  });
  await dispatchRunner({ jobId: job.id });

  revalidatePath("/dashboard/runs/" + run.id);
}

/** Stop a run. Queued work is cancelled immediately; an in-flight stage is
    allowed to finish its write rather than being torn down mid-transaction. */
export async function killRunAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) return;

  const runId = String(formData.get("runId") ?? "");

  await db
    .update(runs)
    .set({ killRequested: true })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.userId, session.user.id),
        /* Never let a stop flag terminate an idle or finished run. */
        notInArray(runs.status, ["done", "failed", "awaiting_approval", "queued"]),
      ),
    );

  await cancelQueuedForRun(runId);
  revalidatePath("/dashboard/runs/" + runId);
}

/** Resume from the last stage that succeeded. Never fakes progress. */
export async function retryRunAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) return;

  const runId = String(formData.get("runId") ?? "");
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, session.user.id)))
    .limit(1);

  if (!run || !["failed", "stopped"].includes(run.status)) return;

  const stage = (run.currentStage ?? "research") as
    | "research"
    | "prompt"
    | "code"
    | "verify"
    | "deploy"
    | "test";

  await logEvent(run.id, "orchestrator", "command", `$ resuming at ${stage}`);

  await db
    .update(runs)
    .set({ status: "queued", error: null, killRequested: false })
    .where(eq(runs.id, run.id));

  const job = await enqueue({ runId: run.id, kind: stage, priority: 10 });
  await dispatchRunner({ jobId: job.id });

  revalidatePath("/dashboard/runs/" + run.id);
}

/** Runs for the dashboard list — newest first. */
export async function listRuns(userId: string) {
  return db
    .select()
    .from(runs)
    .where(eq(runs.userId, userId))
    .orderBy(asc(runs.createdAt));
}