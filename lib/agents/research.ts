/* The Research Agent.

   One sentence in, a sourced ResearchBrief out. This is the stage the previous
   build never shipped, and it is built to the rule that makes the whole pipeline
   defensible: **it cannot fail a run**. Every dependency — the model chain and
   the search chain — is designed to degrade, and this agent converts that
   degradation into an honest brief instead of a dead run.

   The honest-degradation ladder, in order:

     1. Full      — searches, reads real pages, and a model writes the brief.
                    `quality: "full"`.
     2. Search-only — search worked but no model answered. The brief is assembled
                    from the evidence directly, with no interpretation.
                    `quality: "search-only"`.
     3. Offline   — nothing answered. A brief is derived from the sentence itself
                    so the pipeline keeps its shape. `quality: "offline"`, and
                    `degradedReason` says exactly why.

   The point of the ladder is that a run always continues and the user is always
   told which rung they got. A fake full-quality brief would be the one
   unacceptable outcome — the product's whole claim is that what it shows you is
   real.

   Search keys are resolved through the credential layer (user's own → platform
   default → keyless), and the model chain through the plan tier, so this agent
   never reads a secret out of the environment directly. */

import {
  type Competitor,
  type MarketSaturation,
  type ResearchBrief,
  type SourcedClaim,
  type SourceRef,
} from "../domain";
import { chatJson, defaultModelFor, type ChatAttempt, type ChatInput } from "../ai/chat";
import { readPage, webSearch, type SearchHit } from "../ai/search";
import type { PlanConfig } from "../plans";

export type ResearchInput = {
  sentence: string;
  plan: PlanConfig;
  userId: string | null;
  /** a model the user chose for this run, or null to let the chain decide */
  preferredModel?: string | null;
  /** a search engine the user chose, or null for the default chain order */
  preferredSearch?: string | null;
  /** append a line to the run's live feed */
  emit: (kind: "info" | "command" | "success" | "warn" | "error" | "url", line: string) => Promise<void>;
  /** keep the job lease alive during long work */
  heartbeat: () => Promise<void>;
  /** wall-clock budget for the whole stage */
  budgetMs?: number;
};

export type ResearchResult = {
  brief: ResearchBrief;
  tokens: number;
  /** false only when the brief is so thin it cannot support a build */
  usable: boolean;
  reason?: string;
};

const DEFAULT_BUDGET = 8 * 60_000;

/** The queries the agent asks. Deliberately six fixed angles rather than a
    model-written query set: the first version of a pipeline should not depend
    on the thing it is measuring, and these six cover the brief's sections. */
function querySet(sentence: string, subject: string): { query: string; why: string }[] {
  /* Each query is deliberately short. The keyed engines cope with a phrase, but
     the keyless rungs behind them are keyword indexes, and a five-word question
     returns nothing from any of them — measured. Short queries keep every rung
     in the chain useful instead of only the first two. */
  const head = subject.split(" ").slice(0, 2).join(" ") || subject;

  return [
    { query: `${head} competitors`, why: "who already exists" },
    { query: `${head} pricing`, why: "what the market charges" },
    { query: `${head} alternatives`, why: "what people switch from" },
    { query: `${head} market`, why: "whether this is growing" },
    { query: `${head} problems`, why: "what is broken today" },
    { query: `${sentence.slice(0, 60)}`, why: "the user's own words" },
  ];
}

/** The subject of the sentence, stripped of the scaffolding that makes it a
    product request: "a CRM for freelance photographers" → "CRM freelance
    photographers". Search engines do better with the nouns than the sentence. */
function subjectOf(sentence: string): string {
  const cleaned = sentence
    .toLowerCase()
    .replace(/\b(build|create|make|an?|the|app|application|tool|platform|website|site|for)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || sentence.trim().toLowerCase();
}

export async function runResearch(input: ResearchInput): Promise<ResearchResult> {
  const started = Date.now();
  const budget = input.budgetMs ?? DEFAULT_BUDGET;
  const deadline = started + budget;

  const sentence = input.sentence.trim();
  const subject = subjectOf(sentence);

  await input.emit("command", `$ lastmile research --subject "${subject}"`);
  await input.emit("info", `research budget: ${Math.round(budget / 1000)}s, model tier ${input.plan.modelTier}`);

  /* ————— 1. search ————— */

  const queries = querySet(sentence, subject);
  const allHits: SearchHit[] = [];
  const queriesRun: string[] = [];
  const searchProvidersUsed = new Set<string>();
  let searchDegraded: string | null = null;

  for (const { query, why } of queries) {
    if (Date.now() >= deadline) {
      await input.emit("warn", `search budget spent after ${queriesRun.length} queries — moving on`);
      break;
    }

    await input.emit("info", `search: ${query}  (${why})`);
    /* A per-query slice of what is left, so one slow engine cannot eat the
       whole stage. */
    const slice = Math.max(8_000, Math.floor((deadline - Date.now()) / Math.max(1, queries.length)));
    const outcome = await webSearch(query, {
      userId: input.userId,
      max: 6,
      budgetMs: slice,
      prefer: input.preferredSearch,
    });

    queriesRun.push(query);
    for (const hit of outcome.hits) allHits.push(hit);
    if (outcome.provider !== "none") searchProvidersUsed.add(outcome.provider);
    if (outcome.degradedReason && !searchDegraded) searchDegraded = outcome.degradedReason;

    await input.emit(
      outcome.hits.length > 0 ? "success" : "warn",
      outcome.hits.length > 0
        ? `  ${outcome.hits.length} result(s) via ${outcome.provider}`
        : `  no results (${outcome.attempts.map((a) => `${a.provider}:${a.detail ?? "empty"}`).join(", ")})`,
    );

    /* The lease has to stay alive across a stage that can run for minutes. */
    await input.heartbeat();
  }

  const sources = dedupeSources(allHits);
  await input.emit(
    sources.length > 0 ? "success" : "warn",
    `search complete: ${sources.length} unique source(s) from ${searchProvidersUsed.size || 0} provider(s)`,
  );

  /* ————— 2. read the most promising pages ————— */

  /* Reading is what turns an attribution into evidence: the brief can only
     quote a competitor's pricing because the page was actually fetched. Cap it
     at four pages, because the model's context is the real constraint. */
  const toRead = sources.slice(0, 4);
  const pages: { url: string; title: string; text: string }[] = [];

  for (const source of toRead) {
    if (Date.now() >= deadline - 20_000) break;
    const page = await readPage(source.url, 12_000);
    if (page.ok && page.text.length > 200) {
      pages.push({ url: page.url, title: page.title, text: page.text });
      await input.emit("info", `  read ${source.host} (${page.text.length} chars)`);
    } else {
      await input.emit("info", `  skipped ${source.host} — ${page.detail ?? "no readable text"}`);
    }
    await input.heartbeat();
  }

  /* ————— 3. the model writes the brief ————— */

  const model = await askModel(input, sentence, subject, sources, pages, deadline);
  const tokens = model.tokens;

  if (model.brief) {
    const brief: ResearchBrief = {
      ...model.brief,
      quality: pages.length > 0 ? "full" : "search-only",
      sources,
      queries: queriesRun,
      reads: pages.length,
      searchProvider: [...searchProvidersUsed].join("+") || "none",
      provider: model.provider,
      providerLabel: model.providerLabel,
      model: model.model,
      tokens,
      elapsedMs: Date.now() - started,
      degradedReason: searchDegraded,
    };
    await input.emit(
      "success",
      `brief ready — ${brief.competitors.length} competitor(s), ${brief.sources.length} source(s), quality ${brief.quality}`,
    );
    return { brief, tokens, usable: true };
  }

  /* ————— 4. no model: assemble from the evidence ————— */

  await input.emit(
    "warn",
    `no model answered (${model.reason ?? "chain exhausted"}) — assembling the brief from search evidence alone`,
  );

  const brief = offlineBrief({
    sentence,
    subject,
    sources,
    pages,
    queriesRun,
    searchProvider: [...searchProvidersUsed].join("+") || "none",
    modelReason: model.reason ?? null,
    searchDegraded,
    elapsedMs: Date.now() - started,
    tokens,
  });

  await input.emit(
    "success",
    `degraded brief ready — ${brief.competitors.length} competitor(s), quality ${brief.quality}`,
  );

  return {
    brief,
    tokens,
    usable: true,
    reason: model.reason ?? undefined,
  };
}

/* ————————————————————————— the model call ————————————————————————— */

type ModelOutcome = {
  brief: ResearchBrief | null;
  provider: string | null;
  providerLabel: string | null;
  model: string | null;
  tokens: number;
  reason: string | null;
};

const BRIEF_SHAPE = `{
  "positioning": "one sentence framing the market position this product could take",
  "audience": ["who specifically pays, most specific first"],
  "competitors": [
    { "name": "", "url": "", "what": "", "pricing": "", "gaps": ["what they leave undone"], "standing": null }
  ],
  "pricing": [{ "claim": "what the market charges", "source": "url this came from" }],
  "saturation": { "level": "empty|thin|crowded|saturated", "evidence": ["what makes this the verdict"] },
  "economics": [{ "claim": "a revenue or cost signal", "source": "url" }],
  "profit": {
    "model": "who pays, how much, how often",
    "signals": [{ "claim": "", "source": "" }],
    "costs": ["what the builder takes on"],
    "verdict": "an honest read on how hard this is to make pay"
  },
  "changes": [{ "before": "part of the user's sentence", "after": "a sharper version", "why": "" }],
  "stack": [{ "name": "", "why": "" }],
  "productionChecklist": ["what must be true before this is real"],
  "flows": [{ "name": "a user flow", "criteria": ["a testable assertion"] }],
  "risks": ["what could go wrong"],
  "gap": "the opening this product can own",
  "confidence": 0.0
}`;

async function askModel(
  input: ResearchInput,
  sentence: string,
  subject: string,
  sources: SourceRef[],
  pages: { url: string; title: string; text: string }[],
  deadline: number,
): Promise<ModelOutcome> {
  const attempts: ChatAttempt[] = [];

  const evidence = sources
    .map((s, i) => `${i + 1}. ${s.title} — ${s.url}`)
    .join("\n");

  const excerpts = pages
    .map((p) => `— ${p.title} (${p.url})\n${p.text.slice(0, 2500)}`)
    .join("\n\n");

  const prompt = `You are the Research Agent for a product pipeline. A user asked for: "${sentence}"

Here is the live evidence gathered from the web.

SOURCES
${evidence || "(no sources could be reached)"}

PAGE EXCERPTS
${excerpts || "(no pages could be read)"}

Write the research brief. Rules that matter:
- Every non-obvious claim must carry the source URL it came from. If the evidence does not support a claim, do not make it — an empty list is better than an invented one.
- Competitors must be real companies you saw in the sources, with their real URLs.
- "saturation.level" must follow the evidence, not optimism.
- "changes" should propose concrete rewrites of the user's own sentence, each with a reason.
- "confidence" is 0..1 and should reflect how much real evidence backed this brief.
- Reply with ONLY a JSON object of this shape, no prose and no markdown fences:

${BRIEF_SHAPE}`;

  const chatInput: ChatInput = {
    tier: input.plan.modelTier,
    userId: input.userId,
    agent: "research",
    preferred: input.preferredModel ?? defaultModelFor(input.plan.modelTier),
    /* One rung may not eat the stage: the remaining budget is the ceiling. */
    timeoutMs: Math.max(20_000, Math.min(120_000, deadline - Date.now())),
    maxRungs: 5,
    onAttempt: async (attempt) => {
      attempts.push(attempt);
      await input.emit(
        attempt.ok ? "success" : "warn",
        `  model ${attempt.provider}/${attempt.model} ${attempt.ok ? "answered" : `failed (${attempt.detail ?? "unknown"})`} in ${Math.round(attempt.ms / 1000)}s`,
      );
    },
  };

  const { value, result, parseError } = await chatJson<Partial<ResearchBrief>>(chatInput, [
    { role: "system", content: "You are a rigorous market researcher. You never invent sources." },
    { role: "user", content: prompt },
  ]);

  if (!result.ok) {
    return {
      brief: null,
      provider: null,
      providerLabel: null,
      model: null,
      tokens: 0,
      reason: result.reason ?? "the model chain failed",
    };
  }

  if (!value) {
    return {
      brief: null,
      provider: result.provider,
      providerLabel: result.providerLabel,
      model: result.model,
      tokens: result.tokens,
      reason: parseError ?? "the model did not return valid JSON",
    };
  }

  return {
    brief: normalizeBrief(value, sentence),
    provider: result.provider,
    providerLabel: result.providerLabel,
    model: result.model,
    tokens: result.tokens,
    reason: null,
  };
}

/** Fill in what the model left out, so a partial reply is still a valid brief
    rather than a crash at render time. Every field the UI reads is guaranteed. */
function normalizeBrief(raw: Partial<ResearchBrief>, sentence: string): ResearchBrief {
  const level = (["empty", "thin", "crowded", "saturated"] as const).includes(
    raw.saturation?.level as MarketSaturation["level"],
  )
    ? (raw.saturation!.level as MarketSaturation["level"])
    : "thin";

  return {
    idea: sentence,
    positioning: str(raw.positioning) || sentence,
    audience: strArray(raw.audience),
    competitors: (raw.competitors ?? []).map((c) => ({
      name: str(c?.name) || "Unknown",
      url: str(c?.url),
      what: str(c?.what),
      pricing: str(c?.pricing) || "not published",
      gaps: strArray(c?.gaps),
      standing: c?.standing ? str(c.standing) : null,
    })),
    pricing: claims(raw.pricing),
    saturation: { level, evidence: strArray(raw.saturation?.evidence) },
    economics: claims(raw.economics),
    profit: {
      model: str(raw.profit?.model),
      signals: claims(raw.profit?.signals),
      costs: strArray(raw.profit?.costs),
      verdict: str(raw.profit?.verdict),
    },
    changes: (raw.changes ?? []).map((c) => ({
      before: str(c?.before),
      after: str(c?.after),
      why: str(c?.why),
    })),
    stack: (raw.stack ?? []).map((s) => ({ name: str(s?.name), why: str(s?.why) })),
    productionChecklist: strArray(raw.productionChecklist),
    flows: (raw.flows ?? []).map((f) => ({ name: str(f?.name), criteria: strArray(f?.criteria) })),
    risks: strArray(raw.risks),
    gap: str(raw.gap),
    sources: [],
    quality: "full",
    confidence: clamp01(raw.confidence),
    queries: [],
    reads: 0,
    provider: null,
    providerLabel: null,
    model: null,
    searchProvider: "none",
    tokens: 0,
    elapsedMs: 0,
    degradedReason: null,
  };
}

/* ————————————————————————— the offline brief ————————————————————————— */

/** Build a brief with no model at all.

    This is the rung that stops "the model is down" from becoming "your run
    failed". It is derived from the sources that *were* found and the sentence
    itself, it is labelled `search-only` or `offline`, and the prompt agent is
    told so — which means a degraded brief still produces a buildable spec,
    just a more conservative one. */
function offlineBrief(args: {
  sentence: string;
  subject: string;
  sources: SourceRef[];
  pages: { url: string; title: string; text: string }[];
  queriesRun: string[];
  searchProvider: string;
  modelReason: string | null;
  searchDegraded: string | null;
  elapsedMs: number;
  tokens: number;
}): ResearchBrief {
  const { sentence, subject, sources, pages } = args;

  /* A competitor is anything the search returned that is not a directory,
     marketplace, or encyclopedia page — those describe a market, they are not
     in it. */
  const DIRECTORY = /wikipedia|reddit|quora|g2\.com|capterra|producthunt|youtube|medium|linkedin|crunchbase|github\.com|stackoverflow/i;
  const competitors: Competitor[] = sources
    .filter((s) => !DIRECTORY.test(s.host))
    .slice(0, 6)
    .map((s) => ({
      name: s.host,
      url: s.url,
      what: s.title,
      pricing: "not published",
      gaps: [],
      standing: null,
    }));

  const hasEvidence = sources.length > 0;

  const quality: ResearchBrief["quality"] = hasEvidence ? "search-only" : "offline";

  const degradedReason =
    args.modelReason ??
    args.searchDegraded ??
    (hasEvidence ? null : "no search provider and no model answered");

  return {
    idea: sentence,
    positioning: `A focused ${subject} product, positioned against what the sources below already cover.`,
    audience: [],
    competitors,
    pricing: [],
    saturation: {
      level: hasEvidence ? "thin" : "empty",
      evidence: hasEvidence
        ? [`${sources.length} source(s) matched the subject; no model was available to weigh them`]
        : ["no evidence was reachable, so saturation could not be assessed"],
    },
    economics: [],
    profit: {
      model: "",
      signals: [],
      costs: [],
      verdict: hasEvidence
        ? "Not assessed — this brief was assembled without a model, so the money story is unread."
        : "Not assessed — no evidence was reachable.",
    },
    changes: [],
    stack: [],
    productionChecklist: [
      "Decide the data model before writing UI",
      "Every flow needs a testable acceptance criterion",
      "The first screen must work with no account",
    ],
    flows: [
      { name: "Create and view a record", criteria: ["the item persists after a reload", "the list shows it"] },
      { name: "Empty state", criteria: ["a first-time user sees a clear next step"] },
    ],
    risks: [
      hasEvidence
        ? "The brief was built without a model, so the market read is shallow"
        : "No web evidence was reachable, so the market read is absent",
    ],
    gap: hasEvidence
      ? "The opening is unassessed — the evidence was gathered but not interpreted."
      : "Unassessed — no evidence was reachable.",
    sources,
    quality,
    confidence: hasEvidence ? 0.2 : 0.05,
    queries: args.queriesRun,
    reads: pages.length,
    provider: null,
    providerLabel: null,
    model: null,
    searchProvider: args.searchProvider,
    tokens: args.tokens,
    elapsedMs: args.elapsedMs,
    degradedReason,
  };
}

/* ————————————————————————— helpers ————————————————————————— */

function dedupeSources(hits: SearchHit[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const hit of hits) {
    if (!hit.url || seen.has(hit.url)) continue;
    seen.add(hit.url);
    out.push({ title: hit.title, url: hit.url, host: hit.host, provider: hit.provider });
  }
  return out;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter(Boolean);
}

function claims(value: unknown): SourcedClaim[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((c) => ({ claim: str((c as SourcedClaim)?.claim), source: str((c as SourcedClaim)?.source) }))
    .filter((c) => c.claim.length > 0);
}

function clamp01(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0.3;
  return Math.min(1, Math.max(0, n));
}
