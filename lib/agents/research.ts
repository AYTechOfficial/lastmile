/* Research Agent — stage 01 of the pipeline.

   Input:  one sentence from the builder.
   Output: a sourced ResearchBrief the Spec Agent can build from — comparable
           products, pricing, the stack it takes to ship, candidate core flows,
           risks, and a defensible market gap.

   It is a real agent, not a prompt wrapper: it plans its own search queries,
   runs them, reads the promising pages, and only then synthesizes. Every step
   reports what it actually did, because those reports are the dashboard feed.

   Degradation is deliberate and staged, so the pipeline never dies on a
   missing key:
     full         LLM + search   → planned queries, read pages, synthesized brief
     search-only  search, no LLM → real sources, template synthesis
     offline      nothing        → deterministic brief, honestly labelled
*/

import { type ChatResult } from "@/lib/ai/providers";
import { agentChat, resolveChain } from "@/lib/ai/registry";
import type { PlanId } from "@/lib/platform/settings";
import { asObjectArray, asString, asStringArray, extractJson } from "@/lib/ai/json";
import { needsAccounts, sanitizeFlows, wantsTeams } from "./scope";
import { activeSearchProvider, fetchPage, hostOf, searchWeb, type SearchHit } from "@/lib/ai/search";

/* ————————————————————————————— types ————————————————————————————— */

export type Competitor = {
  name: string;
  url: string;
  what: string;
  pricing: string;
  gaps: string[];
};

export type SourcedClaim = { claim: string; source: string };

export type ResearchBrief = {
  idea: string;
  /** one-line market framing */
  positioning: string;
  audience: string[];
  competitors: Competitor[];
  pricing: SourcedClaim[];
  stack: { name: string; why: string }[];
  productionChecklist: string[];
  flows: { name: string; criteria: string[] }[];
  risks: string[];
  /** the gap this product can own */
  gap: string;
  sources: { title: string; url: string; host: string; provider: string }[];
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

export type AgentEvent = {
  kind: "info" | "command" | "success" | "warn" | "error" | "url";
  line: string;
  /** optional structured payload the engine persists alongside the event */
  flow?: { position: number; name: string; assertions: number; status: "pass" | "fixed"; attempts: number; durationMs: number };
};

export type Emit = (event: AgentEvent) => Promise<void> | void;

/* ————————————————————————— query planning ————————————————————————————— */

const STOP = new Set([
  "a", "an", "the", "for", "with", "of", "to", "and", "in", "on", "my", "that", "which",
  "app", "application", "tool", "platform", "website", "site", "build", "create",
]);

/** Keyword extraction that survives any sentence, model or not. */
function keywords(idea: string): string[] {
  return idea
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 8);
}

function heuristicQueries(idea: string): string[] {
  const kw = keywords(idea);
  const core = kw.slice(0, 4).join(" ") || idea.slice(0, 60);
  return [
    core + " software",
    "best " + core,
    core + " alternatives pricing",
    core + " tech stack architecture",
  ];
}

async function planQueries(idea: string, plan: PlanId, llmReady: boolean, emit: Emit): Promise<{ queries: string[]; via: "llm" | "heuristic" }> {
  if (!llmReady) return { queries: heuristicQueries(idea), via: "heuristic" };

  try {
    const res = await agentChat(plan, "research", [
      {
        role: "system",
        content:
          "You are the query planner for a market-research agent. You turn a one-sentence product idea into web search queries that will surface comparable products, their pricing, and the engineering stack needed to build it.",
      },
        {
          role: "user",
          content:
            `Product idea: "${idea}"\n\n` +
            "Write 4 web search queries. Rules:\n" +
            "- each one is 3-9 words, no quotes, no boolean operators\n" +
            "- cover: (1) direct competitors, (2) the incumbent or best-known option, (3) pricing/comparison, (4) the stack or architecture used to build this\n" +
            '- respond with ONLY {"queries": ["...", "...", "...", "..."]}',
        },
      ],
      { temperature: 0.5, maxTokens: 300, json: true, timeoutMs: 25_000 },
    );

    const parsed = extractJson<{ queries?: unknown }>(res.text);
    const queries = asStringArray(parsed?.queries, 5);
    if (queries.length >= 3) return { queries, via: "llm" };
    await emit({ kind: "warn", line: `-> query planner returned ${queries.length} usable queries - falling back to keyword plan` });
  } catch (err) {
    await emit({
      kind: "warn",
      line: "-> query planner unavailable (" + brief(err) + ") - using keyword plan",
    });
  }
  return { queries: heuristicQueries(idea), via: "heuristic" };
}

function brief(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").slice(0, 90);
}

/* ————————————————————————— gathering ————————————————————————————— */

function hostAllowed(url: string): boolean {
  try {
    const h = hostOf(url);
    // listicles and social noise crowd out real comparable products
    return !/(^|\.)(reddit|quora|pinterest|facebook|instagram|tiktok|youtube|linkedin|x|twitter)\.com$/.test(h);
  } catch {
    return false;
  }
}

async function gather(
  queries: string[],
  emit: Emit,
): Promise<{ hits: SearchHit[]; provider: string; reads: number; errors: number }> {
  const seen = new Map<string, SearchHit>();
  const usedProviders = new Set<string>();
  let errors = 0;

  for (const q of queries) {
    try {
      const { hits, provider: used } = await searchWeb(q, { max: 6 });
      usedProviders.add(used);
      let fresh = 0;
      for (const hit of hits) {
        if (!hostAllowed(hit.url)) continue;
        const key = hit.url.replace(/[#?].*$/, "").replace(/\/$/, "");
        if (seen.has(key)) continue;
        seen.set(key, hit);
        fresh++;
      }
      await emit({
        kind: "info",
        line: `-> searched "${q}" - ${fresh} new source${fresh === 1 ? "" : "s"} (${seen.size} total)`,
      });
    } catch (err) {
      errors++;
      await emit({ kind: "warn", line: `-> search failed for "${q}" - ${brief(err)}` });
    }
  }

  const hits = [...seen.values()].slice(0, 18);

  // top hits with only a snippet get their page opened for real text
  const needsRead = hits.filter((h) => !h.content).slice(0, 3);
  let reads = hits.filter((h) => Boolean(h.content)).length;

  if (needsRead.length > 0) {
    await emit({
      kind: "info",
      line: "-> opening " + needsRead.map((h) => hostOf(h.url)).join(", "),
    });
    const pages = await Promise.all(
      needsRead.map(async (h) => ({ hit: h, text: await fetchPage(h.url, 3000) })),
    );
    for (const { hit, text } of pages) {
      if (text) {
        hit.content = text;
        reads++;
      }
    }
  }

  // the chain can fall through mid-run (DDG rate-limits, Tavily answers next),
  // so report every provider that actually served a query
  const provider = usedProviders.size > 0 ? [...usedProviders].join(" + ") : activeSearchProvider().label;

  await emit({
    kind: "success",
    line: `-> research gathered - ${hits.length} sources from ${provider}${reads ? `, ${reads} read in full` : ""}`,
  });

  return { hits, provider, reads, errors };
}

/* ————————————— evidence digest for the synthesis call ————————————— */

function digest(hits: SearchHit[], budget = 14_000): string {
  const parts: string[] = [];
  let used = 0;
  for (const [i, h] of hits.entries()) {
    const body = (h.content ?? h.snippet ?? "").replace(/\s+/g, " ").trim();
    const chunk =
      `[${i + 1}] ${h.title}\n` + `URL: ${h.url}\n` + `EXCERPT: ${body.slice(0, 1400)}\n`;
    if (used + chunk.length > budget) break;
    parts.push(chunk);
    used += chunk.length;
  }
  return parts.join("\n");
}

/* ————————————————————————— synthesis ————————————————————————————— */

const SYNTH_SYSTEM = `You are the Research Agent inside LastMile, a pipeline that turns one sentence into a verified, deployed product.

You are given SOURCES gathered from live web search. Produce a research brief that a senior engineer would actually build from.

Absolute rules:
- Never invent a URL. Every "url" you output must be copied exactly from the SOURCES block.
- If the sources do not establish a fact, say so plainly ("not published") instead of guessing.
- Prefer 3-5 real comparable products over a long list of vague ones.
- Core flows are what the product must do to be worth shipping — each with testable acceptance criteria, because these later become the live verification tests.
- Auth policy: propose signup/login flows ONLY when the idea genuinely requires accounts (multiplayer, teams, SaaS dashboards, user-generated content). A single-player game, a local tool, or a utility ships with ZERO auth flows — never invent them.
- Write for a builder: concrete nouns, no marketing adjectives.`;

function synthPrompt(idea: string, evidence: string): string {
  return (
    `PRODUCT IDEA: "${idea}"\n\n` +
    `SOURCES:\n${evidence}\n\n` +
    "Return ONLY this JSON object:\n" +
    `{
  "positioning": "one sentence framing the market this enters",
  "audience": ["3-5 specific groups, not 'everyone'"],
  "competitors": [
    { "name": "real product name", "url": "exact URL from SOURCES", "what": "what it does in one line",
      "pricing": "published pricing, or 'not published'", "gaps": ["1-3 concrete openings for a new entrant"] }
  ],
  "pricing": [ { "claim": "a pricing or market fact", "source": "hostname it came from" } ],
  "stack": [ { "name": "technology", "why": "why this stack suits THIS product" } ],
  "productionChecklist": ["what it takes to run this in production, one per item"],
  "flows": [ { "name": "core flow name", "criteria": ["2-4 testable acceptance criteria"] } ],
  "risks": ["2-4 real risks, specific"],
  "gap": "the specific gap this product can own, one or two sentences",
  "confidence": 0.0
}`
  );
}

function coerceBrief(
  raw: Record<string, unknown>,
  idea: string,
  allowedUrls: Set<string>,
): Omit<ResearchBrief, "quality" | "provider" | "providerLabel" | "model" | "searchProvider" | "tokens" | "elapsedMs" | "queries" | "reads" | "degradedReason"> {
  const competitors = asObjectArray(raw.competitors, 6)
    .map((c) => {
      const url = asString(c.url);
      return {
        name: asString(c.name) || hostOf(url),
        url,
        what: asString(c.what),
        pricing: asString(c.pricing) || "not published",
        gaps: asStringArray(c.gaps, 3),
      };
    })
    // the whole point: a brief whose links do not exist is worse than a short one
    .filter((c) => c.name && allowedUrls.has(c.url.replace(/\/$/, "")));

  const flows = sanitizeFlows(
    asObjectArray(raw.flows, 5)
      .map((f) => ({ name: asString(f.name), criteria: asStringArray(f.criteria, 4) }))
      .filter((f) => f.name && f.criteria.length > 0),
    idea,
  );

  return {
    idea,
    positioning: asString(raw.positioning) || `A focused tool for ${keywords(idea).slice(0, 3).join(" ")}.`,
    audience: asStringArray(raw.audience, 5),
    competitors,
    pricing: asObjectArray(raw.pricing, 5)
      .map((p) => ({ claim: asString(p.claim), source: asString(p.source) }))
      .filter((p) => p.claim),
    stack: asObjectArray(raw.stack, 8)
      .map((s) => ({ name: asString(s.name), why: asString(s.why) }))
      .filter((s) => s.name),
    productionChecklist: asStringArray(raw.productionChecklist, 8),
    flows,
    risks: asStringArray(raw.risks, 5),
    gap: asString(raw.gap),
    sources: [],
    confidence: typeof raw.confidence === "number" ? Math.min(1, Math.max(0, raw.confidence)) : 0.5,
  };
}

/* ————————————————————————— fallbacks ————————————————————————————— */

function searchOnlyBrief(
  idea: string,
  hits: SearchHit[],
  reason: string,
): Omit<ResearchBrief, "quality" | "provider" | "providerLabel" | "model" | "searchProvider" | "tokens" | "elapsedMs" | "queries" | "reads" | "degradedReason"> & { degradedReason: string } {
  const kw = keywords(idea);
  const subject = kw.slice(0, 3).join(" ") || "this product";
  // treat the top distinct hosts as the comparable set — real names, real links
  const byHost = new Map<string, SearchHit>();
  for (const h of hits) {
    const host = hostOf(h.url);
    if (!byHost.has(host)) byHost.set(host, h);
  }
  const competitors = [...byHost.values()].slice(0, 4).map((h) => ({
    name: h.title.split(/[|\u2013\u2014-]/)[0].trim().slice(0, 60) || hostOf(h.url),
    url: h.url,
    what: h.snippet.slice(0, 180) || "comparable product in this space",
    pricing: /pricing|\$|\/mo|\/month/i.test(h.snippet) ? "pricing published on site" : "not published",
    gaps: ["positioning not yet synthesized — add a model key for deeper analysis"],
  }));

  return {
    idea,
    positioning: `A focused ${subject} product that competes on doing the core job well rather than on feature volume.`,
    audience: userAudience(kw),
    competitors,
    pricing: [],
    stack: [
      { name: "Next.js", why: "server-rendered app with a single deployable unit — fast to verify end to end" },
      { name: "Postgres", why: "durable relational data with real constraints, not a JSON blob" },
      { name: "Tailwind", why: "keeps the UI consistent without a design system detour" },
      ...(needsAccounts(idea)
        ? [{ name: "Auth.js", why: "email + OAuth sign-in without building session plumbing" }]
        : []),
    ],
    productionChecklist: [
      ...(needsAccounts(idea)
        ? ["Email/password and OAuth sign-in with sessions that survive reload"]
        : ["Zero-friction first run — the product works the second it loads, no account needed"]),
      "One core record type with validation errors surfaced inline",
      "Data durable across hard reloads and redeploys",
      "Empty, loading and error states on every list view",
      "Deploy with environment secrets, not hardcoded keys",
    ],
    flows: defaultFlows(subject, idea),
    risks: [
      "Crowded category — differentiation has to be visible in the first screen",
      "Account and data lifecycle (export, delete) is easy to skip and expensive to add later",
      reason,
    ],
    gap: `Nobody in the sources above closes the loop on the ${subject} problem end to end; the opening is a narrower, faster tool that finishes the job.`,
    sources: [],
    confidence: 0.35,
    degradedReason: reason,
  };
}

function userAudience(kw: string[]): string[] {
  const subject = kw.slice(0, 2).join(" ") || "the target workflow";
  return [
    `People who already do ${subject} work by hand`,
    "Small teams without an engineer on staff",
    "Buyers currently paying for an over-featured incumbent",
  ];
}

function defaultFlows(subject: string, idea: string): { name: string; criteria: string[] }[] {
  const noun = subject.split(" ")[0] || "record";
  const accounts = needsAccounts(idea);
  const flows: { name: string; criteria: string[] }[] = [];
  if (accounts) {
    flows.push({
      name: "Signup → login → dashboard",
      criteria: [
        "New account from email + password in under 30s",
        "Wrong password shows an inline error, never a blank page",
        "Session survives reload",
      ],
    });
  }
  flows.push(
    {
      name: accounts ? `Create ${noun} record - persists on reload` : `Use the ${noun} end to end`,
      criteria: [
        accounts ? "Create from the dashboard in one screen" : "The core interaction completes with visible, immediate feedback",
        accounts ? "Data survives a hard reload" : "A full session works start to finish with zero console errors",
        "Validation errors are inline and specific",
      ],
    },
    {
      name: accounts ? "Edit and archive a record" : "State persists across reload",
      criteria: [
        accounts ? "Edits persist" : "Progress survives a hard reload",
        accounts ? "Archived items stay out of the default list" : "First visit shows a sensible empty/first-run state",
      ],
    },
  );
  if (wantsTeams(idea)) {
    flows.push({
      name: "Invite teammate by email",
      criteria: ["Invite renders a pending state instantly", "Email queuing is idempotent"],
    });
  }
  return flows;
}

function offlineBrief(idea: string, reason: string) {
  return searchOnlyBrief(idea, [], reason);
}

/* ————————————————————————— orchestration —————————————————————————— */

export type ResearchRun = { brief: ResearchBrief; chatCalls: number };

export async function research(idea: string, plan: PlanId, emit: Emit): Promise<ResearchRun> {
  const started = Date.now();
  const sentences = idea.trim().replace(/\.$/, "");
  let chatCalls = 0;
  let tokens = 0;
  const meta: { provider: string | null; providerLabel: string | null; model: string | null } = {
    provider: null,
    providerLabel: null,
    model: null,
  };
  const markCall = (res: ChatResult) => {
    chatCalls++;
    tokens += res.tokens;
    meta.provider = res.provider;
    meta.providerLabel = res.providerLabel;
    meta.model = res.model;
  };

  let searchProvider = activeSearchProvider().label;

  await emit({ kind: "command", line: `$ lastmile research "${sentences.toLowerCase()}"` });

  // the research agent uses the same chain every other agent uses: admin-
  // configured providers first, then env keys — never just env keys
  const llmReady = (await resolveChain(plan, "research")).providers.length > 0;
  if (!llmReady) {
    await emit({
      kind: "warn",
      line: "-> no model available for the research agent - running search-only synthesis (configure a provider in Admin → Providers or add an env key)",
    });
  }

  /* 1 — plan */
  await emit({ kind: "info", line: "-> research agent online - planning the search" });
  const { queries, via } = await planQueries(sentences, plan, llmReady, emit);
  await emit({
    kind: "info",
    line: `-> ${queries.length} queries planned (${via === "llm" ? "model-planned" : "keyword plan"})`,
  });

  /* 2 — gather */
  let hits: SearchHit[] = [];
  let reads = 0;
  let gathered = false;
  try {
    const g = await gather(queries, emit);
    hits = g.hits;
    reads = g.reads;
    searchProvider = g.provider;
    gathered = hits.length > 0;
  } catch (err) {
    await emit({ kind: "warn", line: "-> search unavailable - " + brief(err) });
  }

  /* 3 — synthesize */
  let briefValue: ReturnType<typeof coerceBrief>;
  let quality: ResearchBrief["quality"];
  let degradedReason: string | null = null;

  const canSynthesize = llmReady && gathered;
  if (canSynthesize) {
    await emit({ kind: "info", line: `-> synthesizing brief from ${hits.length} sources - ${reads} read in full` });
    try {
      const res = await agentChat(plan, "research", [
        { role: "system", content: SYNTH_SYSTEM },
        { role: "user", content: synthPrompt(sentences, digest(hits)) },
      ],
        { temperature: 0.3, maxTokens: 3000, json: true, timeoutMs: 90_000 },
      );
      markCall(res);
      const parsed = extractJson<Record<string, unknown>>(res.text);
      if (!parsed) throw new Error("model returned no parseable JSON");

      const allowed = new Set(hits.map((h) => h.url.replace(/\/$/, "")));
      briefValue = coerceBrief(parsed, sentences, allowed);
      quality = "full";

      const dropped = asObjectArray(parsed.competitors, 6).length - briefValue.competitors.length;
      if (dropped > 0) {
        await emit({
          kind: "warn",
          line: `-> dropped ${dropped} competitor${dropped === 1 ? "" : "s"} whose URLs were not in the sources (no invented links)`,
        });
      }
      if (briefValue.competitors.length === 0 && hits.length > 0) {
        await emit({ kind: "warn", line: "-> model produced no linkable competitors - backfilling from search results" });
        const backfill = searchOnlyBrief(sentences, hits, "backfilled from search results");
        briefValue.competitors = backfill.competitors;
        quality = "search-only";
        degradedReason = backfill.degradedReason;
      }
    } catch (err) {
      await emit({ kind: "warn", line: "-> synthesis failed (" + brief(err) + ") - falling back to search-only brief" });
      const fb = searchOnlyBrief(sentences, hits, "model synthesis failed; brief derived from search results");
      briefValue = fb;
      quality = "search-only";
      degradedReason = fb.degradedReason;
    }
  } else {
    const reason = gathered
      ? "no model key configured; brief derived from search results"
      : "no search provider reachable; brief is a deterministic baseline";
    const fb = gathered
      ? searchOnlyBrief(sentences, hits, reason)
      : offlineBrief(sentences, reason);
    briefValue = fb;
    quality = gathered ? "search-only" : "offline";
    degradedReason = fb.degradedReason;
    await emit({
      kind: "warn",
      line: gathered ? "-> search-only brief assembled" : "-> offline baseline brief assembled",
    });
  }

  const sources = hits.map((h) => ({
    title: h.title.slice(0, 120),
    url: h.url,
    host: hostOf(h.url),
    provider: h.provider,
  }));

  const finalBrief: ResearchBrief = {
    ...briefValue,
    sources,
    quality,
    queries,
    reads,
    provider: meta.provider,
    providerLabel: meta.providerLabel,
    model: meta.model,
    searchProvider,
    tokens,
    elapsedMs: Date.now() - started,
    degradedReason,
  };

  await emit({
    kind: "success",
    line:
      `-> research done - ${finalBrief.competitors.length} comparable products, ` +
      `${finalBrief.flows.length} core flows, ${sources.length} sources`,
  });
  if (finalBrief.gap) {
    await emit({ kind: "success", line: "-> market gap: " + finalBrief.gap.replace(/\s+/g, " ").slice(0, 180) });
  }

  return { brief: finalBrief, chatCalls };
}
