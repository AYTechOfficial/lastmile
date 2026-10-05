/* Model access layer — every provider we use speaks the OpenAI chat-completions
   dialect, so one client covers all of them and a new provider is a few lines.

   Provider chain (fastest usable first, all no-credit-card):
     1. NVIDIA NIM         NVIDIA_API_KEY      — 40 req/min, hosted MoE models
     2. Google AI Studio   GEMINI_API_KEY      — 1M context, best structured output
     3. Groq               GROQ_API_KEY        — fastest tokens/sec
     4. Cerebras           CEREBRAS_API_KEY    — ~1M tokens/day on the free plan
     5. OpenRouter         OPENROUTER_API_KEY  — ':free' catalog + free router

   With zero keys configured this module reports itself unavailable and callers
   degrade to their deterministic fallback. Nothing in the pipeline hard-fails
   just because nobody signed up yet. */

export type ChatRole = "system" | "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

export type ProviderId = "nim" | "gemini" | "groq" | "cerebras" | "openrouter";

type ProviderDef = {
  id: ProviderId;
  label: string;
  /** OpenAI-compatible base — the client appends /chat/completions */
  baseUrl: string;
  keyEnv: string;
  /** model env override */
  modelEnv: string;
  /** ordered preference; the first that answers wins */
  models: string[];
  /** per-agent model pins, e.g. the code agent runs the provider's coding
      specialist — the generated-app build gate is what those tokens pay for.
      Overrides `models` for that agent only; every other agent keeps the
      default order. */
  modelsByAgent?: Partial<Record<string, string[]>>;
  /** surfaced in the UI so a signed-up key is visibly doing work */
  signupUrl: string;
  freeTier: string;
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: "nim",
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    modelEnv: "NIM_MODEL",
    // live-smoked against the real catalog: laguna answers JSON mode in ~4s
    // with zero reasoning leakage; glm-5.3-flash and deepseek-v4.1-flash hang
    // on this endpoint, and nemotron-3.5-lightning puts its thinking into
    // `content`, so neither is chain-safe. nemotron-3-super returns clean JSON
    // with a separate (unused-by-us) reasoning field.
    models: ["nvidia/nemotron-3-super-120b-a12b", "poolside/laguna-xs-2.1", "moonshotai/kimi-k3"],
    // the code agent gets the coding specialist first: it burns the most
    // tokens and its output is gate-checked by a real build
    modelsByAgent: {
      code: ["poolside/laguna-xs-2.1", "nvidia/nemotron-3-super-120b-a12b", "moonshotai/kimi-k3"],
    },
    signupUrl: "https://build.nvidia.com/settings",
    freeTier: "40 req/min, hosted by NVIDIA",
  },
  {
    id: "gemini",
    label: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    modelEnv: "GEMINI_MODEL",
    models: ["gemini-2.5-flash", "gemini-2.0-flash"],
    signupUrl: "https://aistudio.google.com/apikey",
    freeTier: "free tier, no card",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    modelEnv: "GROQ_MODEL",
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
    signupUrl: "https://console.groq.com/keys",
    freeTier: "30 req/min free, no card",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    keyEnv: "CEREBRAS_API_KEY",
    modelEnv: "CEREBRAS_MODEL",
    models: ["llama-3.3-70b", "llama3.1-8b"],
    signupUrl: "https://cloud.cerebras.ai",
    freeTier: "~1M tokens/day free",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    modelEnv: "OPENROUTER_MODEL",
    models: ["openrouter/free", "meta-llama/llama-3.3-70b-instruct:free"],
    signupUrl: "https://openrouter.ai/keys",
    freeTier: "20 req/min on :free models",
  },
];

export type ProviderState = {
  def: ProviderDef;
  configured: boolean;
  model: string;
};

/** Which providers have a key present, in chain order. */
export function providerStates(): ProviderState[] {
  const order = process.env.AI_PROVIDER_ORDER?.split(",").map((s) => s.trim()).filter(Boolean);
  const list = order?.length
    ? [...PROVIDERS].sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      })
    : PROVIDERS;
  return list.map((def) => ({
    def,
    configured: Boolean(process.env[def.keyEnv]?.trim()),
    model: process.env[def.modelEnv]?.trim() || def.models[0],
  }));
}

export function configuredProviders(): ProviderState[] {
  return providerStates().filter((p) => p.configured);
}

export function hasLLM(): boolean {
  return configuredProviders().length > 0;
}

export type ChatResult = {
  text: string;
  provider: ProviderId;
  providerLabel: string;
  model: string;
  tokens: number;
  elapsedMs: number;
  /** true when the model was asked for JSON and we got parseable JSON back */
  json: boolean;
};

export class AllProvidersFailed extends Error {
  readonly attempts: { provider: ProviderId; model: string; error: string }[];
  constructor(attempts: { provider: ProviderId; model: string; error: string }[]) {
    super(
      attempts.length === 0
        ? "No model provider is configured — add a free API key to .env.local"
        : "Every configured provider failed: " +
            attempts.map((a) => `${a.provider}/${a.model} (${a.error})`).join("; "),
    );
    this.name = "AllProvidersFailed";
    this.attempts = attempts;
  }
}

export type ChatOptions = {
  temperature?: number;
  maxTokens?: number;
  /** ask the provider for a JSON object (and validate it parses) */
  json?: boolean;
  timeoutMs?: number;
};

/** An explicit credential — the registry resolves these from admin settings
    or env keys; nothing else in the codebase touches raw keys. */
export type ExplicitProvider = {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
};

function estimateTokens(...texts: string[]): number {
  return Math.ceil(texts.join(" ").length / 4);
}

/** OpenAI-compatible gateways serve the API under /v1 — when someone pastes a
    bare origin ("https://1412520.bond") we would otherwise POST into the
    website itself and get HTML back. Give bare origins their /v1. */
function endpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname === "" || parsed.pathname === "/") return parsed.origin + "/v1";
  } catch {
    // not a valid URL — let fetch surface the error downstream
  }
  return trimmed;
}

async function callProvider(
  id: string,
  label: string,
  baseUrl: string,
  key: string,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<ChatResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  const started = Date.now();

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 2048,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  try {
    const res = await fetch(endpoint(baseUrl) + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + key,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });

    const raw = await res.text();
    if (!res.ok) {
      // surface the provider's own words — usually tells you the model id moved
      throw new Error(res.status + " " + raw.slice(0, 220).replace(/\s+/g, " "));
    }

    let parsed: {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { total_tokens?: number };
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("provider returned non-JSON: " + raw.slice(0, 160));
    }

    if (parsed.choices?.[0]?.finish_reason === "length") {
      // the output budget ran out mid-answer — a re-roll or a smaller ask may fit
      throw new Error("response truncated (finish_reason length)");
    }

    const text = parsed.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      // gpt-oss models on some hosts put reasoning in a separate field
      throw new Error("empty completion");
    }

    return {
      text,
      provider: id as ProviderId,
      providerLabel: label,
      model,
      tokens: parsed.usage?.total_tokens ?? estimateTokens(...messages.map((m) => m.content), text),
      elapsedMs: Date.now() - started,
      json: opts.json ? true : false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/* ————————————————————— provider health —————————————————————

   A provider that cannot serve this workload must not be retried on every
   single call. The textbook case: a "thinking" model whose reasoning eats the
   entire max_tokens budget, so it answers finish_reason=length with zero
   content — deterministically, for every request above a few hundred tokens.
   It also takes ~60s to do it, so leaving it in rotation costs the run a
   minute of wall clock per agent call, every call.

   Once a provider+model fails that way three times in a row it is benched for
   a few minutes. Only DETERMINISTIC failures bench a provider: truncation and
   empty completions. Rate limits, timeouts and 5xx stay in rotation — those
   are transient and the provider is fine. A provider that answers is instantly
   un-benched, so a temporary outage heals on its own. */

const BENCH_AFTER = 3;
const BENCH_MS = 5 * 60_000;

type BenchEntry = { strikes: number; until: number };
const health = ((globalThis as unknown as { __lmProviderHealth?: Map<string, BenchEntry> }).__lmProviderHealth ??= new Map<string, BenchEntry>());

/** Deterministic: re-asking this model cannot help. */
function isDeterministic(message: string): boolean {
  // insufficient_quota included: a plan/credit wall will not lift mid-call, so
  // strike immediately and let the bench fail over to the next provider
  return /truncated|response too long|maximum context length|finish_reason length|empty completion|non-JSON|invalid api key|unknown model|does not exist|insufficient_quota|quota exceeded|payment required/i.test(
    message,
  );
}

function strike(bucket: string): void {
  const cur = health.get(bucket);
  const strikes = (cur?.strikes ?? 0) + 1;
  health.set(bucket, { strikes, until: strikes >= BENCH_AFTER ? Date.now() + BENCH_MS : 0 });
}

function isBenched(bucket: string): boolean {
  return (health.get(bucket)?.until ?? 0) > Date.now();
}

/**
 * Run a chat completion through an explicit provider chain — admin-configured
 * endpoints first, then the env chain. Tries each provider, and each of its
 * preferred models, until one answers. Retries once per attempt on transient
 * status codes.
 */
export async function chatWith(
  providers: ExplicitProvider[],
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const attempts: { provider: ProviderId; model: string; error: string }[] = [];

  /* Never bench an entire chain: if nothing is currently usable, ignore the
     bench and try anyway rather than hard-failing the stage. A benched chain
     is a hint, not a wall. */
  const buckets = providers.flatMap((p) => Array.from(new Set(p.models)).map((m) => ({ p, m, key: p.id + "/" + m })));
  const anyUsable = buckets.some((b) => !isBenched(b.key));
  if (!anyUsable && buckets.length > 0) {
    for (const b of buckets) health.delete(b.key);
  }

  for (const state of providers) {
    const models = Array.from(new Set(state.models));
    for (const model of models) {
      const bucket = state.id + "/" + model;
      if (isBenched(bucket)) {
        attempts.push({
          provider: state.id as ProviderId,
          model,
          error: "benched — it cannot serve this workload (skipped)",
        });
        continue;
      }

      // three tries per model — openai-compatible gateways intermittently
      // return a 200 with empty content on long prompts (finish_reason stop,
      // no text), which is random and only clears on a re-roll
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await callProvider(state.id, state.label, state.baseUrl, state.apiKey, model, messages, opts);
          health.delete(bucket); // it answered — it is healthy again
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // a hit the model's output ceiling is deterministic for this prompt:
          // re-asking the same model only burns time, so fail over to the next
          // provider/model immediately instead of re-rolling.
          if (isDeterministic(message)) {
            strike(bucket);
            attempts.push({ provider: state.id as ProviderId, model, error: message.replace(/\s+/g, " ").slice(0, 140) });
            break;
          }
          // a bad key or unknown model will not fix itself — stop retrying this model
          const transient =
            /\b(429|500|502|503|504|abort|timeout|fetch failed|ECONNRESET|empty completion)\b/i.test(message);
          // an empty completion is worth a re-roll (it is random on some
          // gateways) but a provider that empties out on every re-roll is not
          // usable, so it counts as one strike once the retries are spent
          if (attempt < 2 && transient) continue;
          if (/empty completion/i.test(message)) strike(bucket);
          attempts.push({ provider: state.id as ProviderId, model, error: message.replace(/\s+/g, " ").slice(0, 140) });
          break;
        }
      }
    }
  }

  throw new AllProvidersFailed(attempts);
}

/**
 * Run a chat completion through the default env provider chain.
 */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const states = configuredProviders();
  const providers: ExplicitProvider[] = states.map((s) => ({
    id: s.def.id,
    label: s.def.label,
    baseUrl: s.def.baseUrl,
    apiKey: process.env[s.def.keyEnv]!.trim(),
    models: Array.from(new Set([s.model, ...s.def.models])),
  }));
  return chatWith(providers, messages, opts);
}
