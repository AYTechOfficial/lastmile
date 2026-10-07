/* Talking to a model, and not failing when one of them is down.

   This is the piece the previous build had in a 393-line provider chain, and it
   is worth having carefully, because every agent in the pipeline sits on it.

   Three things it does that a naive `fetch(provider)` does not:

     1. It walks a CHAIN, not a provider. The rungs are, in order:
        the user's own endpoints → the plan's platform catalog → the environment
        defaults. A rung that is unconfigured is skipped, and a rung that fails
        is stepped over with the reason recorded. A model that returns 429, 503,
        500, or times out is a rung that failed — not the end of the call.

     2. It speaks BOTH dialects. Some of these endpoints are OpenAI-shaped
        (`/chat/completions`), some are Anthropic-shaped (`/messages`). Rather
        than making the caller know which, the transport decides: it tries the
        OpenAI shape first and falls back to the Anthropic shape on a 404/405,
        then remembers which one worked for that base URL.

     3. It prefers a model the user CHOSE. `preferred` is a model id the run
        asked for; when it is set, the chain is reordered so that model is tried
        first, and every other rung still stands behind it as fallback. That is
        what makes "pick a model, or let us pick the fastest" real rather than
        cosmetic — a chosen model is a preference, never a single point of
        failure.

   It never throws for a provider problem. It returns `{ ok: false, attempts }`
   with the reasons attached, so a stage can decide whether to degrade or stop —
   and the run's log gets the honest story instead of a bare "AI failed". */

import {
  AION_MODEL_IDS,
  HCNSEC_MODEL_IDS,
  PREFERRED_FREE_MODEL,
  TRUE_MODEL_IDS,
} from "./catalog";
import { resolveProviders, type ResolvedProvider } from "../platform/settings";
import { activeUserProviders } from "../platform/user-providers";
import type { AgentId } from "../platform/settings";
import type { ModelTier } from "../plans";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatAttempt = {
  provider: string;
  model: string;
  ok: boolean;
  status?: number;
  /** why this rung failed, in the provider's own words where possible */
  detail?: string;
  ms: number;
};

export type ChatResult = {
  ok: boolean;
  text: string;
  provider: string | null;
  providerLabel: string | null;
  model: string | null;
  tokens: number;
  elapsedMs: number;
  attempts: ChatAttempt[];
  /** the chain was exhausted, or nothing was configured at all */
  reason?: string;
};

export type ChatInput = {
  /** the plan tier whose catalog may be used */
  tier: ModelTier;
  /** the user whose own endpoints should be tried first */
  userId?: string | null;
  /** which agent is calling — lets the operator pin a model per agent */
  agent?: AgentId;
  /** a model id the user chose for this run; tried first when present */
  preferred?: string | null;
  /** cap on how long one rung may take */
  timeoutMs?: number;
  /** how many rungs to try before giving up */
  maxRungs?: number;
  /** how many models of any ONE provider may be tried before the chain moves
      on — without this, a provider whose whole catalog fails eats the budget
      and every other provider is never reached */
  perProviderRungs?: number;
  /** called as each rung is attempted, so the run log can show the walk */
  onAttempt?: (attempt: ChatAttempt) => Promise<void> | void;
};

const DEFAULT_TIMEOUT = 90_000;
const DEFAULT_MAX_RUNGS = 12;

/* ————————————————————————— what the chain has learned —————————————————————————

   Two memories, both in-process and both deliberately cheap. A model that just
   returned 404 has been retired and will never answer again today; a model that
   returned 429 is out of quota for a few minutes; a provider that answered
   once is a better first guess than a benchmark measured weeks ago. Without
   these, every stage re-walks the same dead rungs — a stale measured order
   puts a retired model first, every call pays for it, and the stage lands on
   whichever slow model happens to sit behind it. */

/** rungs to skip for a while, keyed `provider|model` */
const cooldown = new Map<string, { until: number; status: number }>();

/** the last rung that actually answered, keyed by tier + agent */
const lastGood = new Map<string, string>();

function rungKey(rung: { id: string; model: string }): string {
  return `${rung.id}|${rung.model}`;
}

/** How long a failure should keep a rung out of the chain. A retired model is
    a fact about the catalog (hours); a quota is a fact about the minute;
    everything else gets one short breath. */
function cooldownMs(status: number, detail: string | undefined): number {
  if (status === 404 || status === 410) return 6 * 60 * 60 * 1000;
  if (status === 401 || status === 403) return 30 * 60 * 1000;
  if (status === 429) return 2 * 60 * 1000;
  if (status >= 500) return 2 * 60 * 1000;
  /* a 400 from a content filter is deterministic for the same request, but the
     next request is usually different — keep the penalty short and local */
  if (/sensitive|content.?filter|policy/i.test(detail ?? "")) return 5 * 60 * 1000;
  return 30 * 1000;
}
/* Two models per provider is enough to tell a broken catalog from a broken
   request: a provider that answers for one model and 500s for another is worth
   keeping in the chain, one that 500s twice is not. */
const DEFAULT_PER_PROVIDER_RUNGS = 2;

/* The dialect an endpoint actually answered on, learned once and reused.
   Keyed by base URL, and only ever a hint — a remembered dialect that starts
   failing is re-learned, because a wrong hint costs one 404, not a run. */
const dialectCache = new Map<string, "openai" | "anthropic">();

type Rung = {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** higher is tried earlier */
  rank: number;
};

/* ————————————————————————— building the chain ————————————————————————— */

/** Flatten the resolution into rungs, one per (provider, model) pair, in the
    order they should be attempted.

    The ordering rule, which is the whole point of this function:

        a model the user picked  →  the agent's pinned model  →  the catalog's
        measured order  →  any remaining model the provider lists

    A user's own endpoint outranks the platform's at every step, because they
    are paying for it. */
async function buildRungs(input: ChatInput): Promise<{ rungs: Rung[]; pinned: boolean }> {
  const rungs: Rung[] = [];
  const preferred = input.preferred?.trim() || null;

  /* A choice from the run-start picker is "provider/model" — the same model id
     can exist on two providers at different speeds, and picking one should not
     silently mean the other. The prefix is only a provider qualifier when it
     names a provider this run can actually use; everything else (the automatic
     default, per-agent pins, older stored choices) is a bare model id and keeps
     its old meaning. Model ids themselves contain slashes (nvidia/llama-…), so
     the prefix MATCH is what disambiguates, not the slash count. */
  const slash = preferred ? preferred.indexOf("/") : -1;
  const prefix = slash > 0 ? preferred!.slice(0, slash) : null;
  const bare = slash > 0 ? preferred!.slice(slash + 1) : preferred;
  let preferredProvider: string | null = null;
  let preferredModel: string | null = preferred;

  /* Rank is GROUP PRIORITY minus the position inside that provider's own model
     order. Two properties fall out of that, and both are load-bearing:

       · Within a provider, the order is exactly what `orderModels` decided —
         the carried-and-preferred models first, the rest behind them.
       · Across providers, a group's priority dominates, so a user's own
         endpoint always outranks the platform's.

     The subtraction is what stops a preferred model from jumping the queue on a
     provider that does not carry it. Ranking by a fixed "is this the preferred
     model" score did exactly that: asking for gemini-2.5-flash made Groq try
     gemini-2.5-flash first and 404, on every provider, before its real model
     answered. The preferred model still leads — on the provider that has it. */
  const push = (
    p: { id: string; label: string; baseUrl: string; apiKey: string },
    models: string[],
    groupPriority: number,
  ) => {
    models.forEach((model, index) => {
      rungs.push({
        id: p.id,
        label: p.label,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model,
        rank: groupPriority - index,
      });
    });
  };

  /* Rung group 1 — the user's own endpoints. The 10,000 base is deliberate: a
     user's own key always outranks the platform's, because they are paying for
     it, and no platform priority value can be set high enough to jump it. */
  const own = input.userId ? await activeUserProviders(input.userId) : [];
  const ownIds = own.map((p) => p.id);
  for (const p of own) {
    push(p, orderModels(p.models, preferredModel), 10_000);
  }

  /* Rung group 2 — the platform catalog for this plan tier, ordered by the
     operator's own priority rather than by array position. */
  const platform = await resolveProviders(input.tier);
  let pinned = false;
  for (const p of platform) {
    const pinnedModel = input.agent ? p.agents[input.agent] : undefined;
    if (pinnedModel) pinned = true;
    push(p, orderModels(p.models, preferredModel, pinnedModel), p.priority);
  }

  /* Resolve the qualifier now that every provider id is known, then lift the
     exact (provider, model) rung the user picked above the rest of the platform
     section — but below the user's own paid endpoints (10_000), which always
     outrank the platform's at every step. */
  if (prefix && bare && [...ownIds, ...platform.map((p) => p.id)].includes(prefix)) {
    preferredProvider = prefix;
    preferredModel = bare;
    const exact = rungs.find((r) => r.id === preferredProvider && r.model === preferredModel);
    if (exact) exact.rank = 9_000;
  }

  rungs.sort((a, b) => b.rank - a.rank);
  return { rungs, pinned };
}

/** Put the interesting models first, keep the rest behind them as fallback.

    The rule is per provider: a model the provider actually carries is tried in
    the given preference order; a preferred model the provider does NOT carry is
    deferred to the end, so asking Groq for a Gemini id — which the old order
    did, because the preferred model led on every rung — does not burn a rung
    per provider before the real model answers. The preferred model still gets
    its turn on the provider that does carry it. */
function orderModels(models: string[], ...prefer: (string | null | undefined)[]): string[] {
  const wanted = prefer.filter((m): m is string => Boolean(m));
  const carried = models.filter((m) => wanted.includes(m));
  const rest = models.filter((m) => !wanted.includes(m));
  /* A preferred model the provider does not list is still worth one try at the
     end — a catalog can lag a provider's real offering. */
  const extra = wanted.filter((m) => !models.includes(m));
  return [...carried, ...rest, ...extra];
}

/* ————————————————————————— the transport ————————————————————————— */

type DialectResult = {
  ok: boolean;
  status: number;
  text: string;
  tokens: number;
  detail?: string;
};

async function callOpenAi(
  rung: Rung,
  messages: ChatMessage[],
  signal: AbortSignal,
  json: boolean,
): Promise<DialectResult> {
  const res = await fetch(`${rung.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${rung.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: rung.model,
      messages,
      /* Low temperature: these agents are extracting structure from evidence,
         not writing prose, and a creative verifier is a useless verifier. */
      temperature: 0.2,
      /* Room for a full page component: the coder writes complete files inside
         a JSON envelope, and a tight default cap truncates the last file
         mid-expression — which then fails the build it was meant to pass. */
      max_tokens: 16_384,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal,
  });

  const raw = await res.text();

  if (!res.ok) {
    return { ok: false, status: res.status, text: "", tokens: 0, detail: providerError(raw, res.status) };
  }

  try {
    const body = JSON.parse(raw) as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    const text = body.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      return { ok: false, status: 200, text: "", tokens: 0, detail: "the endpoint returned an empty message" };
    }
    return { ok: true, status: 200, text, tokens: body.usage?.total_tokens ?? 0 };
  } catch {
    return { ok: false, status: 200, text: "", tokens: 0, detail: "the endpoint returned a body that is not JSON" };
  }
}

async function callAnthropic(
  rung: Rung,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<DialectResult> {
  /* The Anthropic shape has no system role in the message list — the system
     prompt is a top-level field. Splitting it here is what lets one caller send
     one message array to either dialect. */
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

  const res = await fetch(`${rung.baseUrl.replace(/\/+$/, "")}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": rung.apiKey,
      Authorization: `Bearer ${rung.apiKey}`,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: rung.model,
      /* Same reasoning as the OpenAI dialect: the coder ships whole files, so
         the cap must leave room for a complete page component and its JSON. */
      max_tokens: 16_384,
      temperature: 0.2,
      ...(system ? { system } : {}),
      messages: rest,
    }),
    signal,
  });

  const raw = await res.text();

  if (!res.ok) {
    return { ok: false, status: res.status, text: "", tokens: 0, detail: providerError(raw, res.status) };
  }

  try {
    const body = JSON.parse(raw) as {
      content?: { type?: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (body.content ?? [])
      .filter((b) => b.type === "text" || typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("");
    if (!text.trim()) {
      return { ok: false, status: 200, text: "", tokens: 0, detail: "the endpoint returned an empty message" };
    }
    const tokens = (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0);
    return { ok: true, status: 200, text, tokens };
  } catch {
    return { ok: false, status: 200, text: "", tokens: 0, detail: "the endpoint returned a body that is not JSON" };
  }
}

/** The provider's own explanation, which is almost always more useful than the
    status code alone — "free quota exhausted" tells an operator what to do,
    "HTTP 429" does not. */
function providerError(raw: string, status: number): string {
  try {
    const body = JSON.parse(raw) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const message =
      typeof body.error === "string" ? body.error : (body.error?.message ?? body.message);
    if (message) return `${status}: ${message.slice(0, 240)}`;
  } catch {
    /* not JSON — fall through to the status alone */
  }
  return `HTTP ${status}`;
}

/** Try one rung, both dialects if needed. Returns the first answer that works. */
async function callRung(
  rung: Rung,
  messages: ChatMessage[],
  timeoutMs: number,
  json: boolean,
): Promise<DialectResult> {
  const key = rung.baseUrl.replace(/\/+$/, "");
  const remembered = dialectCache.get(key);

  const order: ("openai" | "anthropic")[] =
    remembered === "anthropic" ? ["anthropic", "openai"] : ["openai", "anthropic"];

  let last: DialectResult = { ok: false, status: 0, text: "", tokens: 0, detail: "not attempted" };

  for (const dialect of order) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const result =
        dialect === "openai"
          ? await callOpenAi(rung, messages, signal, json)
          : await callAnthropic(rung, messages, signal);

      if (result.ok) {
        dialectCache.set(key, dialect);
        return result;
      }

      /* 404/405 means "wrong shape for this host" — worth the other dialect.
         Anything else (401, 429, 503, quota) is a verdict about the credential
         or the model, and retrying it in another dialect just wastes the
         budget. */
      const wrongShape = result.status === 404 || result.status === 405;
      last = result;
      if (!wrongShape) return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /abort|timeout/i.test(message);
      last = {
        ok: false,
        status: timedOut ? 408 : 0,
        text: "",
        tokens: 0,
        detail: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : message,
      };
      /* A timeout is a verdict too: the next rung is a better use of the
         remaining budget than the same host again. */
      if (timedOut) return last;
    }
  }

  return last;
}

/* ————————————————————————— the public call ————————————————————————— */

export async function chat(input: ChatInput, messages: ChatMessage[]): Promise<ChatResult> {
  const started = Date.now();
  const attempts: ChatAttempt[] = [];
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxRungs = input.maxRungs ?? DEFAULT_MAX_RUNGS;
  const perProviderRungs = input.perProviderRungs ?? DEFAULT_PER_PROVIDER_RUNGS;

  const built = await buildRungs(input);
  let rungs = built.rungs;

  if (rungs.length === 0) {
    return {
      ok: false,
      text: "",
      provider: null,
      providerLabel: null,
      model: null,
      tokens: 0,
      elapsedMs: Date.now() - started,
      attempts,
      reason:
        "no model is configured for this plan — add a provider key in Settings, or have the operator configure the platform catalog",
    };
  }

  /* A model that answered a moment ago is the best first guess: the benchmark
     order behind it may name models this provider has since retired, and every
     one of those is a wasted call in the middle of a stage. The promotion is
     tier-wide as well as agent-wide — a model proven by the prompt stage is a
     good first guess for the coder — and it never outranks an agent the
     operator has pinned, whose whole point is a stable output run to run. */
  const agentKey = `${input.tier}|${input.agent ?? "any"}`;
  const tierKey = `${input.tier}|any`;
  const remembered = lastGood.get(agentKey) ?? lastGood.get(tierKey);
  if (
    !built.pinned &&
    remembered &&
    rungs.length > 1 &&
    rungs[0] &&
    rungKey(rungs[0]) !== remembered
  ) {
    const i = rungs.findIndex((r) => rungKey(r) === remembered);
    if (i > 0) rungs = [rungs[i]!, ...rungs.slice(0, i), ...rungs.slice(i + 1)];
  }

  /* Cooled-down rungs sit behind the healthy ones — but they are never removed
     outright. If everything is cold, trying them beats failing without trying. */
  const now = Date.now();
  const healthy = rungs.filter((r) => (cooldown.get(rungKey(r))?.until ?? 0) <= now);
  const cold = rungs.filter((r) => (cooldown.get(rungKey(r))?.until ?? 0) > now);
  const ordered = [...healthy, ...cold];
  if (cold.length > 0 && healthy.length > 0) {
    const n = cold.length;
    const why = cooldown.get(rungKey(cold[0]!))?.status;
    console.log(`chat: ${n} rung(s) in cooldown behind ${healthy.length} healthy (first cold status ${why})`);
  }

  const tried: Rung[] = [];
  const perProvider = new Map<string, number>();
  let lastDetail = "no rung answered";

  for (const rung of ordered) {
    if (tried.length >= maxRungs) break;

    /* Skip a (provider, model) pair already tried: `orderModels` can place the
       same model in two groups when a user pins what the catalog already
       leads with, and paying twice for one model is pure waste. */
    if (tried.some((t) => t.id === rung.id && t.model === rung.model)) continue;

    /* Provider fairness: a provider gets at most `perProviderRungs` attempts,
       then the chain moves to the next one. Free endpoints fail in ways that
       have nothing to do with the request — a content filter, a daily quota, a
       model that was retired this morning — and the run must still be able to
       reach a provider that can answer. */
    const used = perProvider.get(rung.id) ?? 0;
    if (used >= perProviderRungs) continue;
    perProvider.set(rung.id, used + 1);
    tried.push(rung);

    const at = Date.now();
    const result = await callRung(rung, messages, timeoutMs, false);

    const attempt: ChatAttempt = {
      provider: rung.label,
      model: rung.model,
      ok: result.ok,
      status: result.status,
      detail: result.detail,
      ms: Date.now() - at,
    };
    attempts.push(attempt);
    if (input.onAttempt) await input.onAttempt(attempt);

    if (result.ok) {
      cooldown.delete(rungKey(rung));
      lastGood.set(agentKey, rungKey(rung));
      lastGood.set(tierKey, rungKey(rung));
      return {
        ok: true,
        text: result.text,
        provider: rung.id,
        providerLabel: rung.label,
        model: rung.model,
        tokens: result.tokens,
        elapsedMs: Date.now() - started,
        attempts,
      };
    }

    cooldown.set(rungKey(rung), {
      until: Date.now() + cooldownMs(result.status, result.detail),
      status: result.status,
    });
    lastDetail = `${rung.label}/${rung.model}: ${result.detail ?? "failed"}`;
  }

  return {
    ok: false,
    text: "",
    provider: null,
    providerLabel: null,
    model: null,
    tokens: 0,
    elapsedMs: Date.now() - started,
    attempts,
    reason: `every model in the chain failed — last was ${lastDetail}`,
  };
}

/* ————————————————————————— structured output ————————————————————————— */

/** Pull the first JSON object or array out of a model reply.

    Models wrap JSON in prose and fences no matter how firmly they are told not
    to. Rather than failing the stage, this finds the value: a fenced block is
    preferred, then the first balanced {...} or [...]. Returns null when there
    is genuinely no JSON in there, which is a real failure worth reporting. */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(text.trim());

  for (const candidate of candidates) {
    const direct = tryParse<T>(candidate);
    if (direct !== null) return direct;

    const sliced = sliceBalanced(candidate);
    if (sliced) {
      const parsed = tryParse<T>(sliced);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function tryParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** The first balanced object/array in a string, respecting strings and escapes
    so a brace inside a quoted sentence does not end the scan early. */
function sliceBalanced(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Ask for JSON, and hand back the parsed value plus how the call went.

    One retry, with the parse error fed back — that single correction turns most
    malformed replies into valid ones, and it costs one call rather than a
    failed stage. */
export async function chatJson<T>(
  input: ChatInput,
  messages: ChatMessage[],
): Promise<{ value: T | null; result: ChatResult; parseError?: string }> {
  const first = await chat(input, messages);
  if (!first.ok) return { value: null, result: first };

  const parsed = extractJson<T>(first.text);
  if (parsed !== null) return { value: parsed, result: first };

  const retry = await chat(input, [
    ...messages,
    { role: "assistant", content: first.text.slice(0, 2000) },
    {
      role: "user",
      content:
        "That reply was not valid JSON. Reply again with ONLY a single JSON value — no prose, no markdown fences.",
    },
  ]);

  if (!retry.ok) return { value: null, result: retry, parseError: "the model did not return valid JSON" };

  const second = extractJson<T>(retry.text);
  return {
    value: second,
    result: retry,
    parseError: second === null ? "the model did not return valid JSON" : undefined,
  };
}

/** The model a run should lead with when the user expressed no preference.
    Exported so the run-start picker and the chain agree on one answer. */
export function defaultModelFor(tier: ModelTier): string | null {
  if (tier === "free") return PREFERRED_FREE_MODEL;
  return null;
}

/** Every model a plan tier may actually use, for the run-start picker.

    The id is qualified — `provider/model` — because the same model id can be
    carried by two providers at different speeds, and picking "glm-5.3" must
    mean the one on the provider whose latency you saw. The chain reads the
    qualifier back (see buildRungs). */
export async function selectableModels(tier: ModelTier): Promise<
  { id: string; model: string; provider: string; providerLabel: string }[]
> {
  const providers: ResolvedProvider[] = await resolveProviders(tier);
  const seen = new Set<string>();
  const out: { id: string; model: string; provider: string; providerLabel: string }[] = [];
  const qualify = (providerId: string, model: string) => `${providerId}/${model}`;

  /* The measured free catalogs lead, so the picker shows the fast models first
     rather than whatever order the JSON happens to be in. */
  if (tier === "free") {
    const measuredOrder: [string, string][] = [
      ...TRUE_MODEL_IDS.map((id) => ["truemodel", id] as [string, string]),
      ...HCNSEC_MODEL_IDS.map((id) => ["hcnsec", id] as [string, string]),
      ...AION_MODEL_IDS.map((id) => ["aionlabs", id] as [string, string]),
    ];
    for (const [providerId, model] of measuredOrder) {
      const owner = providers.find((p) => p.id === providerId && p.models.includes(model));
      if (!owner) continue;
      const key = qualify(providerId, model);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: key, model, provider: owner.id, providerLabel: owner.label });
    }
  }

  for (const p of providers) {
    for (const model of p.models) {
      const key = qualify(p.id, model);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: key, model, provider: p.id, providerLabel: p.label });
    }
  }

  return out;
}
