"use server";

import { and, asc, count, eq, gte, inArray, notInArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { jobs, runs, users } from "@/lib/schema";
import { cancelQueuedForRun, enqueue } from "@/lib/queue";
import { planOf } from "@/lib/plans";
import { logEvent } from "@/lib/events";
import { dispatchRunner } from "@/lib/platform/runner";
import { rateLimit } from "@/lib/rate-limit";
import { getBalanceMilli } from "@/lib/credits";
import { normalizeSentence, slugify, titleFrom, SENTENCE_MAX, SENTENCE_MIN } from "@/lib/slug";
import { defaultModelFor, selectableModels } from "@/lib/ai/chat";
import { searchOrder, searchProviderStates } from "@/lib/ai/search";
import { AION_MODELS, describeModel, HCNSEC_MODELS, TRUE_MODELS } from "@/lib/ai/catalog";
import type { RunOptionsDTO } from "@/lib/ai/options";

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
    .select({ plan: users.plan, suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  /* A suspended account cannot start work. Checked here as well as at sign-in:
     a block should end the spending, not just the browsing. */
  if (user?.suspendedAt) {
    return { error: "This account is suspended, so new runs are on hold. An operator can lift it." };
  }

  const tier = planOf(user?.plan);

  /* Credits first: a run spends real tokens, so an empty balance refuses at
     the door rather than failing mid-build with work half-paid for. */
  const balanceMilli = await getBalanceMilli(session.user.id);
  if (balanceMilli <= 0) {
    return {
      error: "Your credit balance is empty — an operator can top it up from the admin panel.",
    };
  }

  /* The two choices the composer offers. Both are validated against what the
     plan may actually use, so a tampered form cannot pin a run to a model or an
     engine the user is not entitled to — and an unknown value degrades to the
     automatic choice rather than failing the run. */
  const chosenModel = String(formData.get("model") ?? "").trim();
  const chosenSearch = String(formData.get("search") ?? "").trim();

  const modelChoice = await validModelChoice(tier, chosenModel);
  const searchChoice = validSearchChoice(chosenSearch);

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
      modelChoice,
      searchChoice,
      startedAt: now,
    })
    .returning();

  await logEvent(
    run.id,
    "research",
    "command",
    `$ lastmile run #${run.runNumber} — "${sentence}"`,
  );
  await logEvent(
    run.id,
    "research",
    "info",
    modelChoice
      ? `model pinned to ${modelChoice}`
      : "model: automatic — the fastest verified model in the chain",
  );
  await logEvent(
    run.id,
    "research",
    "info",
    `search: ${searchChoice ?? "automatic"} (Tavily → Exa → DuckDuckGo → Wikipedia, first that answers)`,
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

/** Stop a run, from anywhere in its life. Queued work is cancelled
    immediately; an in-flight stage is allowed to finish its write rather than
    being torn down mid-transaction, and the runner honours the flag at the
    next claim. When nothing is in flight any more the run is marked stopped
    right here — it must never linger as "queued" with no work attached. */
export async function killRunAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) return;

  const runId = String(formData.get("runId") ?? "");

  const stopped = await db
    .update(runs)
    .set({ killRequested: true })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.userId, session.user.id),
        /* A stop flag must never touch a finished run or the human checkpoint —
           awaiting_approval has its own review flow. */
        notInArray(runs.status, ["done", "failed", "awaiting_approval", "stopped"]),
      ),
    )
    .returning({ id: runs.id });

  if (stopped.length === 0) return;

  await cancelQueuedForRun(runId);

  /* Nothing left in flight? The run is over now, not when some runner next
     claims a job that no longer exists. */
  const [{ remaining }] = await db
    .select({ remaining: count() })
    .from(jobs)
    .where(and(eq(jobs.runId, runId), inArray(jobs.status, ["queued", "running"])));

  if (Number(remaining) === 0) {
    await db
      .update(runs)
      .set({ status: "stopped", completedAt: new Date() })
      .where(eq(runs.id, runId));
    await logEvent(runId, "orchestrator", "warn", "run stopped by you — nothing was in flight");
  } else {
    await logEvent(
      runId,
      "orchestrator",
      "warn",
      "stop requested — the current stage will finish, then the run stops",
    );
  }

  revalidatePath("/dashboard/runs/" + runId);
}

/** Delete a project. The run row cascades: jobs, events, agent runs, issues
    and flows all belong to it. The code and the deploy live on GitHub and
    Vercel under the user's own accounts and are not touched here. */
export async function deleteRunAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) return;

  const runId = String(formData.get("runId") ?? "");
  if (!runId) return;

  await db.delete(runs).where(and(eq(runs.id, runId), eq(runs.userId, session.user.id)));

  revalidatePath("/dashboard");
  redirect("/dashboard");
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

/* ————————————————————————— continue building ————————————————————————— */

/** What the continue-classifier may answer. `pipeline` names the stage whose
    agent the request is really about; `research` means re-search first, and
    everything else lands on the prompt agent to re-interpret the product. */
type ContinuePlan = {
  pipeline: "research" | "prompt" | "code" | "verify" | "test";
  reasoning: string;
};

/** Classify a continue request with a model, so "add auth and signup" lands on
    the prompt agent, "find me cheaper competitors" re-runs research, and "the
    buttons look dead" goes straight to the coder. A template keyword match
    would misroute real requests — this is exactly the mistake the research
    query planner made before it became model-driven, so the router is a model
    too. Falls back to the prompt stage: the safest general answer, since a
    request that re-interprets the product can still reach every later stage
    through the checkpoint. */
async function classifyContinueRequest(
  request: string,
  tier: "free" | "premium",
): Promise<ContinuePlan> {
  const { chatJson } = await import("@/lib/ai/chat");
  const { value } = await chatJson<Partial<ContinuePlan>>(
    {
      tier,
      userId: null,
      agent: "spec",
      timeoutMs: 45_000,
      maxRungs: 4,
    },
    [
      {
        role: "system",
        content:
          'You route a user\'s change request for an already-built web product to the right pipeline stage. "research" re-runs web research first (market, competitors, pricing questions). "prompt" re-plans the product (new features, new pages, auth, signup, new flows, design overhauls). "code" is a direct build change that needs no re-planning (a copy tweak, a colour, one component). "verify" re-checks the existing code. "test" re-runs live QA. Reply ONLY JSON: {"pipeline": "research"|"prompt"|"code"|"verify"|"test", "reasoning": "one sentence"}.',
      },
      { role: "user", content: `THE PRODUCT'S ORIGINAL REQUEST AND THE USER'S NEW REQUEST FOLLOW.\n\nNEW REQUEST: ${request.slice(0, 800)}` },
    ],
  );

  const pipeline = value?.pipeline;
  if (pipeline === "research" || pipeline === "prompt" || pipeline === "code" || pipeline === "verify" || pipeline === "test") {
    return { pipeline, reasoning: (value?.reasoning ?? "").trim().slice(0, 200) || "model-routed" };
  }
  return { pipeline: "prompt", reasoning: "router did not answer cleanly — routed to the prompt agent" };
}

/** Continue building on a run that already ended.

    The user types what they want next — "add auth and signup", "make it look
    premium", "research cheaper competitors" — and the request is routed to
    whichever agent it is really for. The router is a model, not keywords; the
    chosen stage is logged on the run so the user can see the decision. From
    there the pipeline's own machinery takes over: the checkpoint still gates
    any build, and the quality loop still runs. */
export async function continueRunAction(
  _prev: ContinueRunState,
  formData: FormData,
): Promise<ContinueRunState> {
  const session = await auth();
  if (!session?.user?.id) return { error: "Sign in to continue building." };

  const runId = String(formData.get("runId") ?? "");
  const request = String(formData.get("request") ?? "").trim().slice(0, 600);
  if (request.length < 5) {
    return { error: "Describe what you want changed or added — at least a few words." };
  }

  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) return { error: "That run no longer exists." };
  if (run.userId !== session.user.id) return { error: "This is not your project." };
  if (!"done,failed,stopped".includes(run.status)) {
    return { error: "This run is still in flight — wait for it to end or stop it first." };
  }

  const [user] = await db
    .select({ plan: users.plan, suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  if (user?.suspendedAt) return { error: "This account is suspended, so new work is on hold." };

  /* Continued work spends real tokens like any run, so an empty balance stops
     here rather than failing mid-build. */
  const balanceMilli = await getBalanceMilli(session.user.id);
  if (balanceMilli <= 0) {
    return { error: "Your credit balance is empty — an operator can top it up from the admin panel." };
  }

  const tier = planOf(user?.plan);
  const limited = await rateLimit(`continue:${session.user.id}`, 6, 60_000);
  if (!limited.ok) return { error: "That is a lot of change requests at once. Give it a minute." };

  const plan = await classifyContinueRequest(request, tier.modelTier);

  await logEvent(
    run.id,
    "orchestrator",
    "command",
    `$ lastmile continue — "${request}"`,
  );
  await logEvent(
    run.id,
    "orchestrator",
    "info",
    `routed to the ${plan.pipeline} agent — ${plan.reasoning}`,
  );

  const variant = run.specVariant + 1;

  if (plan.pipeline === "research") {
    await db
      .update(runs)
      .set({ status: "queued", currentStage: "research", error: null, killRequested: false, specVariant: variant, approvedAt: null, completedAt: null })
      .where(eq(runs.id, run.id));
    const job = await enqueue({ runId: run.id, kind: "research", payload: { continueRequest: request }, priority: 5 });
    await dispatchRunner({ jobId: job.id });
  } else if (plan.pipeline === "prompt") {
    await db
      .update(runs)
      .set({ status: "queued", currentStage: "prompt", specVariant: variant, approvedAt: null, completedAt: null, error: null, killRequested: false })
      .where(eq(runs.id, run.id));
    const job = await enqueue({ runId: run.id, kind: "prompt", payload: { variant, guidance: request, continueRequest: true }, priority: 5 });
    await dispatchRunner({ jobId: job.id });
  } else if (plan.pipeline === "code") {
    await db
      .update(runs)
      .set({ status: "queued", currentStage: "code", error: null, killRequested: false, approvedAt: run.approvedAt, completedAt: null })
      .where(eq(runs.id, run.id));
    const job = await enqueue({
      runId: run.id,
      kind: "code",
      payload: { fixOnly: true, from: "continue", continueRequest: request, iteration: run.iterations + 1 },
      priority: 5,
    });
    await dispatchRunner({ jobId: job.id });
  } else {
    // verify or test — a re-check of what exists, then the pipeline takes over
    const kind = plan.pipeline === "verify" ? "verify" : "test";
    await db
      .update(runs)
      .set({ status: "queued", currentStage: kind, error: null, killRequested: false, completedAt: null })
      .where(eq(runs.id, run.id));
    const job = await enqueue({ runId: run.id, kind, payload: { continueRequest: request }, priority: 5 });
    await dispatchRunner({ jobId: job.id });
  }

  revalidatePath("/dashboard/runs/" + run.id);
  return { ok: true, notice: `Routed to the ${plan.pipeline} agent — the run is queued again.` };
}

export type ContinueRunState = { ok?: boolean; notice?: string; error?: string };

/** Runs for the dashboard list — newest first. */
export async function listRuns(userId: string) {
  return db
    .select()
    .from(runs)
    .where(eq(runs.userId, userId))
    .orderBy(asc(runs.createdAt));
}

/* ————————————————————————— run-start choices ————————————————————————— */

/** The models this plan may actually pick from, and the engines it may pick.
    Read by the composer so the options are never invented client-side. */
export async function runOptions(userId: string): Promise<RunOptionsDTO> {
  const [user] = await db
    .select({ plan: users.plan })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const tier = planOf(user?.plan);

  const [models, search] = await Promise.all([
    selectableModels(tier.modelTier),
    searchProviderStates(userId),
  ]);

  /* The measured catalogs are the only place latency/throughput is known, so
     the note is attached here rather than invented per provider — keyed by the
     qualified id the picker now uses, since the same model can sit on two
     providers at different speeds. */
  const measured = new Map<string, string>();
  for (const [providerId, list] of [
    ["truemodel", TRUE_MODELS],
    ["hcnsec", HCNSEC_MODELS],
    ["aionlabs", AION_MODELS],
  ] as const) {
    for (const m of list) measured.set(`${providerId}/${m.id}`, describeModel(m));
  }

  const modelOptions = models.map((m) => ({ ...m, note: measured.get(m.id) }));

  /* Clustered for the picker: one row per provider, its models behind it. The
     order is the chain's own priority order, so the top cluster is the one a
     run actually leads with. */
  const clusterOrder: { id: string; label: string }[] = [];
  for (const m of modelOptions) {
    if (!clusterOrder.some((c) => c.id === m.provider)) {
      clusterOrder.push({ id: m.provider, label: m.providerLabel });
    }
  }

  return {
    models: modelOptions,
    groups: clusterOrder.map((c) => ({
      provider: c.id,
      providerLabel: c.label,
      models: modelOptions.filter((m) => m.provider === c.id),
    })),
    search: search.map((s) => ({
      id: s.id,
      label: s.label,
      configured: s.configured,
      keyless: s.keyless,
    })),
    plan: tier.id,
    automaticModel: defaultModelFor(tier.modelTier),
  };
}

/** A model id is accepted only if the plan's catalog actually offers it. An
    unknown id silently becomes "automatic" — the run must not fail because a
    stale client posted a model that has since been retired. */
async function validModelChoice(
  tier: ReturnType<typeof planOf>,
  chosen: string,
): Promise<string | null> {
  if (!chosen) return null;
  const available = await selectableModels(tier.modelTier);
  return available.some((m) => m.id === chosen) ? chosen : null;
}

/** Same rule for the search engine: only the engines the chain knows. */
function validSearchChoice(chosen: string): string | null {
  const value = chosen.trim().toLowerCase();
  return (searchOrder() as string[]).includes(value) ? value : null;
}