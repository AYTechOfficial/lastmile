/* The provider catalog, as the operator edits it.

   `settings.ts` owns reading and writing the one settings row; this file owns
   the *rules* around the part of it that decides where a run's models come
   from — validation, key handling, ordering, and the health results a Test run
   leaves behind. Actions in the admin panel call these, never `updatePlatformData`
   directly, so a bad form cannot write a catalog the pipeline cannot use.

   Two invariants, both learned from what breaks in practice:

     1. A provider that cannot answer is worse than no provider: it costs every
        stage the rung it burns. So a provider must have a base URL, at least one
        model, and a key (stored encrypted, or an env var name) before it joins
        the chain at all — and the last enabled provider of a tier may not be
        deleted, because that silently empties the chain.

     2. Order is data, not luck. Priority is explicit and rewritten from the
        operator's own arrangement; auto-arrange derives it from measured
        latency rather than from anyone's guess. */

import { encryptSecret } from "../crypto";
import type { ModelTier } from "../plans";
import type {
  AgentId,
  CatalogHealth,
  ModelHealth,
  PlatformData,
  ProviderEntry,
} from "./settings";
import { getPlatformData, updatePlatformData } from "./settings";

/* ————————————————————————— validation ————————————————————————— */

export type ProviderInput = {
  id?: string | null;
  label: string;
  baseUrl: string;
  /** plaintext key, when the operator pasted one this time */
  apiKey?: string | null;
  /** env var name, when the key lives in the environment instead */
  keyEnv?: string | null;
  models: string;
  tier: ModelTier;
  notes?: string | null;
  enabled?: boolean;
};

export type ProviderProblem = { field: string; message: string };

/** Turn the form into the entry, or explain exactly what is wrong with it.
    Returning every problem at once is deliberate: an operator fixing a catalog
    should not have to resubmit to discover the second mistake. */
export function validateProvider(
  input: ProviderInput,
  current: PlatformData,
): { problems: ProviderProblem[]; models: string[] } {
  const problems: ProviderProblem[] = [];

  const label = input.label.trim();
  if (label.length < 2) problems.push({ field: "label", message: "Give the provider a name." });

  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
    problems.push({ field: "baseUrl", message: "The base URL must start with http:// or https://" });
  }

  const models = [
    ...new Set(
      input.models
        .split(/[\n,]/)
        .map((m) => m.trim())
        .filter(Boolean),
    ),
  ];
  if (models.length === 0) {
    problems.push({ field: "models", message: "List at least one model id — one per line." });
  }
  if (models.some((m) => m.length > 160 || /\s/.test(m))) {
    problems.push({ field: "models", message: "Model ids cannot contain spaces — one id per line." });
  }

  if (input.tier !== "free" && input.tier !== "premium") {
    problems.push({ field: "tier", message: "Tier must be free or premium." });
  }

  const id = input.id?.trim();
  const existing = id ? current.providers.find((p) => p.id === id) : undefined;
  const apiKey = input.apiKey?.trim() ?? "";
  const keyEnv = input.keyEnv?.trim() ?? "";
  const hasStoredKey = Boolean(existing?.keyEncrypted);
  const hasEnvKey = Boolean(keyEnv);

  if (!hasStoredKey && !hasEnvKey && apiKey.length === 0) {
    problems.push({
      field: "apiKey",
      message: "Paste an API key (kept encrypted), or name the env var that holds it.",
    });
  }
  if (apiKey && apiKey.length < 8) {
    problems.push({ field: "apiKey", message: "That key looks too short to be real." });
  }
  if (keyEnv && !/^[A-Z][A-Z0-9_]*$/.test(keyEnv)) {
    problems.push({ field: "keyEnv", message: "An env var name is upper-case letters, digits and underscores." });
  }

  return { problems, models: models.length > 0 ? models.slice(0, 24) : [] };
}

/** A stable id from the label: `Together AI` → `together-ai`. The id is what
    run logs, priorities and health results key on, so it never changes on an
    edit — only on creation. */
export function providerIdFrom(label: string, current: PlatformData): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "provider";
  if (!current.providers.some((p) => p.id === base)) return base;
  for (let n = 2; n < 99; n += 1) {
    const candidate = `${base}-${n}`;
    if (!current.providers.some((p) => p.id === candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

/* ————————————————————————— mutations ————————————————————————— */

export type CatalogResult =
  | { ok: true; entry: ProviderEntry; notice: string }
  | { ok: false; problems: ProviderProblem[] };

/** Create or update one provider. A pasted key is encrypted here; an empty key
    field on an edit means "keep the key that is already stored", which is the
    difference between editing a label and silently disarming a provider. */
export async function saveProvider(input: ProviderInput): Promise<CatalogResult> {
  const current = await getPlatformData();
  const { problems, models } = validateProvider(input, current);
  if (problems.length > 0) return { ok: false, problems };

  const id = input.id?.trim() || providerIdFrom(input.label, current);
  const existing = current.providers.find((p) => p.id === id);
  const apiKey = input.apiKey?.trim() ?? "";
  const keyEnv = input.keyEnv?.trim() ?? "";

  const entry: ProviderEntry = {
    id,
    label: input.label.trim(),
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
    keyEncrypted: apiKey ? encryptSecret(apiKey) : (existing?.keyEncrypted ?? null),
    keyEnv: keyEnv || (apiKey ? null : (existing?.keyEnv ?? null)),
    models,
    tier: input.tier,
    enabled: input.enabled ?? existing?.enabled ?? true,
    /* A new provider joins at the bottom of the failover order until the
       operator moves it — being added is not a claim about being good. */
    priority: existing?.priority ?? Math.min(0, ...current.providers.map((p) => p.priority)) - 10,
    agents: existing?.agents ?? {},
    notes: input.notes?.trim() || existing?.notes || null,
  };

  await updatePlatformData((data) => ({
    ...data,
    providers: data.providers.some((p) => p.id === id)
      ? data.providers.map((p) => (p.id === id ? entry : p))
      : [...data.providers, entry],
  }));

  return {
    ok: true,
    entry,
    notice: `${entry.label} ${existing ? "updated" : "added"} — ${entry.models.length} model(s), ${entry.tier} tier, ${entry.enabled ? "enabled" : "disabled"}.`,
  };
}

export async function deleteProvider(id: string): Promise<{ ok: boolean; error?: string; notice?: string }> {
  const current = await getPlatformData();
  const entry = current.providers.find((p) => p.id === id);
  if (!entry) return { ok: false, error: "That provider is already gone." };

  const sameTier = current.providers.filter((p) => p.tier === entry.tier && p.enabled);
  if (entry.enabled && sameTier.length <= 1) {
    return {
      ok: false,
      error: `${entry.label} is the last enabled ${entry.tier} provider — deleting it would leave that tier with no models to run.`,
    };
  }

  await updatePlatformData((data) => ({
    ...data,
    providers: data.providers.filter((p) => p.id !== id),
  }));
  return { ok: true, notice: `${entry.label} removed from the catalog.` };
}

export async function setProviderEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string; notice?: string }> {
  const current = await getPlatformData();
  const entry = current.providers.find((p) => p.id === id);
  if (!entry) return { ok: false, error: "No such provider." };

  if (!enabled) {
    const others = current.providers.filter((p) => p.tier === entry.tier && p.enabled && p.id !== id);
    if (entry.enabled && others.length === 0) {
      return {
        ok: false,
        error: `${entry.label} is the last enabled ${entry.tier} provider — disabling it would leave runs with no models.`,
      };
    }
  }

  await updatePlatformData((data) => ({
    ...data,
    providers: data.providers.map((p) => (p.id === id ? { ...p, enabled } : p)),
  }));
  return { ok: true, notice: `${entry.label} ${enabled ? "enabled" : "disabled"}.` };
}

/** Rewrite priorities from the operator's own order: first in the list is
    reached first. Numbers are spread by 10 so a later hand-edit has room, and
    every provider in the id list is renumbered — an arrangement is a statement
    about the whole chain, not a patch.

    The array is rewritten to the same order. It used to leave the array alone,
    and that discrepancy was the "my order undid itself" bug: the chain walks
    priorities, but a panel that renders the array drew the old arrangement on
    the next load, and only auto-arrange ever rewrote the array. One order,
    stored once. */
export async function setProviderOrder(ids: string[]): Promise<{ ok: boolean; error?: string; notice?: string }> {
  const current = await getPlatformData();
  const known = new Set(current.providers.map((p) => p.id));
  const ordered = ids.filter((id) => known.has(id));
  if (ordered.length === 0) return { ok: false, error: "The new order did not name any provider." };

  /* Providers the drag list did not name keep their relative order — by their
     existing priority, not by accident — and follow the dragged ones. */
  const missing = current.providers
    .filter((p) => !ordered.includes(p.id))
    .sort((a, b) => b.priority - a.priority)
    .map((p) => p.id);
  const full = [...ordered, ...missing];

  await updatePlatformData((data) => {
    const rank = new Map(full.map((id, index) => [id, full.length - index]));
    return {
      ...data,
      providers: full
        .map((id) => data.providers.find((p) => p.id === id))
        .filter((p): p is ProviderEntry => Boolean(p))
        .map((p) => ({ ...p, priority: rank.get(p.id) ?? 0 })),
    };
  });

  return { ok: true, notice: `Failover order saved — ${ordered[0]} is reached first.` };
}

/** Widen a provider's model list order, so the models that answer fastest are
    the ones the chain reaches first within that provider. */
export async function setProviderModels(id: string, models: string[]): Promise<void> {
  await updatePlatformData((data) => ({
    ...data,
    providers: data.providers.map((p) => (p.id === id ? { ...p, models } : p)),
  }));
}

/** Pin an agent to one model, or clear the pin with an empty string. A pin is
    what stops the two stages a person actually reads — the spec and the master
    prompt — from following whatever the failover chain happened to land on. */
export async function setAgentPins(providerId: string, pins: Partial<Record<AgentId, string>>): Promise<{ ok: boolean; error?: string; notice?: string }> {
  const current = await getPlatformData();
  const entry = current.providers.find((p) => p.id === providerId);
  if (!entry) return { ok: false, error: "No such provider." };

  const cleaned: Partial<Record<AgentId, string>> = {};
  for (const [agent, model] of Object.entries(pins)) {
    const value = (model ?? "").trim();
    if (!value) continue;
    if (!entry.models.includes(value)) {
      return { ok: false, error: `${entry.label} does not list ${value} — add the model first.` };
    }
    cleaned[agent as AgentId] = value;
  }

  await updatePlatformData((data) => ({
    ...data,
    providers: data.providers.map((p) => (p.id === providerId ? { ...p, agents: cleaned } : p)),
  }));

  const count = Object.keys(cleaned).length;
  return { ok: true, notice: count > 0 ? `${entry.label}: ${count} agent pin(s) saved.` : `${entry.label}: pins cleared.` };
}

/* ————————————————————————— health ————————————————————————— */

/** Write the outcome of a probe. Kept in the settings row beside the catalog it
    describes, so the admin page shows what the last Test found instead of
    forgetting it the moment the request ends. Results merge per model: testing
    one model must not erase the reading for a model that was not tested. */
export async function saveHealth(providerId: string, perModel: Record<string, ModelHealth>): Promise<CatalogHealth> {
  const next = await updatePlatformData((data) => {
    const health: CatalogHealth = { ...(data.health ?? {}) };
    const previous = health[providerId]?.models ?? {};
    const merged: Record<string, ModelHealth> = { ...previous, ...perModel };
    const best = Math.min(
      ...Object.values(merged)
        .filter((m) => m.ok)
        .map((m) => m.ms),
      Number.POSITIVE_INFINITY,
    );
    health[providerId] = {
      at: new Date().toISOString(),
      models: merged,
      best: Number.isFinite(best) ? best : null,
    };
    return { ...data, health };
  });
  return next.health ?? {};
}

/** Rearrange the whole catalog by what the probes measured: the provider whose
    fastest model answered soonest leads, everything that failed or was never
    tested keeps its relative place at the end. Models move inside their
    provider by the same rule, because within a provider the array order is the
    rung order after the first pass.

    Measured latency is the only input. A provider that was never probed is not
    guessed at — it is left where the operator put it. */
export async function autoArrange(): Promise<{ ok: boolean; error?: string; notice?: string; order?: string[] }> {
  const current = await getPlatformData();
  const health: CatalogHealth = current.health ?? {};

  const tested = current.providers.filter((p) => health[p.id]);
  if (tested.length === 0) {
    return { ok: false, error: "Nothing has been tested yet — run Test first, then auto-arrange." };
  }

  const rank = (p: ProviderEntry): number => {
    const best = health[p.id]?.best ?? null;
    return best === null ? Number.POSITIVE_INFINITY : best;
  };

  const sorted = [...current.providers].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return b.priority - a.priority;
  });

  const withModels = sorted.map((p) => {
    const measured = health[p.id]?.models ?? {};
    const models = [...p.models].sort((a, b) => {
      const ma = measured[a];
      const mb = measured[b];
      const va = ma?.ok ? ma.ms : Number.POSITIVE_INFINITY;
      const vb = mb?.ok ? mb.ms : Number.POSITIVE_INFINITY;
      if (va !== vb) return va - vb;
      return p.models.indexOf(a) - p.models.indexOf(b);
    });
    return { ...p, models };
  });

  const order = withModels.map((p) => p.id);
  await updatePlatformData((data) => ({
    ...data,
    providers: withModels.map((p) => ({ ...p, priority: (withModels.length - order.indexOf(p.id)) * 10 })),
  }));

  const leader = withModels[0];
  const leadMs = leader ? (health[leader.id]?.best ?? null) : null;
  return {
    ok: true,
    order,
    notice:
      leadMs !== null
        ? `Arranged by measured speed — ${leader?.label} leads at ${leadMs}ms; models reordered inside each provider.`
        : "Arranged by measured speed.",
  };
}

/* ————————————————————————— presets ————————————————————————— */

/** Known OpenAI-compatible endpoints, so adding one is picking it from a list
    rather than looking up a base URL. This is a convenience, not a whitelist:
    the form accepts any URL, which is the point — a provider that does not
    exist yet today should not need a code change tomorrow. */
export type ProviderPreset = {
  id: string;
  label: string;
  baseUrl: string;
  keyEnv: string;
  models: string[];
  notes: string;
  tier: ModelTier;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    models: ["openai/gpt-oss-120b"],
    notes: "free tier, very fast",
    tier: "free",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    models: ["nvidia/llama-3.3-nemotron-super-49b-v1"],
    notes: "40 req/min free",
    tier: "free",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    keyEnv: "CEREBRAS_API_KEY",
    models: ["llama-3.3-70b"],
    notes: "~1M tokens/day free",
    tier: "free",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    models: ["openrouter/free", "meta-llama/llama-3.3-70b-instruct:free"],
    notes: "':free' catalog plus a free router",
    tier: "free",
  },
  {
    id: "aionlabs",
    label: "Aion Labs",
    baseUrl: "https://api.aionlabs.ai/v1",
    keyEnv: "AION_API_KEY",
    models: ["aion-labs/aion-3.5"],
    notes: "uncensored catalog",
    tier: "free",
  },
  {
    id: "hcnsec",
    label: "HCNSEC",
    baseUrl: "https://api.hcnsec.cn/v1",
    keyEnv: "HCNSEC_API_KEY",
    models: ["DeepSeek-V4-Pro", "DeepSeek-V4-Flash"],
    notes: "DeepSeek, GLM, Qwen, Step",
    tier: "free",
  },
  {
    id: "truemodel",
    label: "1412 (TrueModel)",
    baseUrl: "https://1412520.bond/v1",
    keyEnv: "TRUEMODEL_API_KEY",
    models: ["gemini-3.6-flash", "qwen3.7-flash-2026-07-15"],
    notes: "benchmarked catalog",
    tier: "free",
  },
  {
    id: "gemini",
    label: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    models: ["gemini-2.5-flash"],
    notes: "generous free tier, 1M context",
    tier: "free",
  },
  {
    id: "together",
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    keyEnv: "TOGETHER_API_KEY",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo"],
    notes: "premium tier — add a key to use it",
    tier: "premium",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyEnv: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"],
    notes: "premium tier — strong at code",
    tier: "premium",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY",
    models: ["mistral-large-latest", "codestral-latest"],
    notes: "premium tier",
    tier: "premium",
  },
  {
    id: "xai",
    label: "xAI",
    baseUrl: "https://api.x.ai/v1",
    keyEnv: "XAI_API_KEY",
    models: ["grok-4", "grok-4-mini"],
    notes: "premium tier",
    tier: "premium",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    models: ["gpt-5.2", "gpt-5.2-mini"],
    notes: "premium tier",
    tier: "premium",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keyEnv: "ANTHROPIC_API_KEY",
    models: ["claude-sonnet-4-6", "claude-haiku-4-6"],
    notes: "premium tier — Anthropic dialect",
    tier: "premium",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    keyEnv: "",
    models: ["llama3.1", "qwen2.5-coder"],
    notes: "self-hosted, no key",
    tier: "free",
  },
];

/** Which agents may be pinned to a model, in the order the admin panel lists
    them. `spec` and `prompt` write the prose a person reads at the checkpoint;
    `code` builds; `verify` and `test` judge. */
export const PINNABLE_AGENTS: { id: AgentId; label: string }[] = [
  { id: "research", label: "Research" },
  { id: "spec", label: "Spec" },
  { id: "prompt", label: "Prompt" },
  { id: "code", label: "Code" },
  { id: "verify", label: "Verify" },
  { id: "test", label: "Live QA" },
];
