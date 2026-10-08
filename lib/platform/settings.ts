import { eq } from "drizzle-orm";
import { db } from "../db";
import { platformSettings } from "../schema";
import { decryptSecret, encryptSecret } from "../crypto";
import type { ModelTier, PlanId } from "../plans";
import { AION_MODEL_IDS, AION_PROVIDER, HCNSEC_MODEL_IDS, HCNSEC_PROVIDER, TRUE_MODEL_IDS, TRUE_PROVIDER } from "../ai/catalog";

/* Operator configuration — everything the admin panel edits, in one row.

   The important part is `policy`: which model tier each plan may route to. That
   single mapping is what implements "the free plan runs on free models, Pro runs
   on premium models", and it is data rather than code, so changing it takes
   effect on the next job with no deploy.

   Provider keys are AES-256-GCM ciphertext. A provider may instead name an env
   variable (`keyEnv`) and keep its key out of the database entirely — which is
   how the env-configured defaults work. */

export type AgentId = "research" | "spec" | "prompt" | "code" | "verify" | "deploy" | "test";

export const AGENT_IDS: AgentId[] = [
  "research",
  "spec",
  "prompt",
  "code",
  "verify",
  "deploy",
  "test",
];

export type ProviderEntry = {
  id: string;
  label: string;
  baseUrl: string;
  /** ciphertext, when the key was entered in the admin panel */
  keyEncrypted: string | null;
  /** env var this provider reads its key from, when it is env-configured */
  keyEnv: string | null;
  models: string[];
  /** which plan tier may use it */
  tier: ModelTier;
  enabled: boolean;
  /**
   * Which provider a run reaches for first. HIGHER WINS, and this is the field
   * that decides the failover order — not the array order, which is only the
   * tie-break.
   *
   * It exists because catalog order was being used as priority, and that made
   * an incidental fact (which provider happened to be typed first) decide which
   * model built people's products. Priority makes the intent explicit and
   * reviewable: a benchmarked provider leads, and a weaker one is kept strictly
   * as a last-resort rung.
   */
  priority: number;
  /** per-agent model pins — the code agent can run a different model to research */
  agents: Partial<Record<AgentId, string>>;
  notes: string | null;
};

export type InfraEntry = {
  githubTokenEncrypted: string | null;
  vercelTokenEncrypted: string | null;
  vercelTeamId: string | null;
};

/** One model's last health probe. Written by the admin Test button, read by
    the panel and by auto-arrange — nothing in the pipeline's hot path depends
    on it, so a stale result is a display problem and never a run problem. */
export type ModelHealth = {
  ok: boolean;
  /** round-trip time of the probe that produced this result */
  ms: number;
  status: number;
  detail?: string;
  /** when the probe ran, ISO */
  at: string;
};

export type ProviderHealth = {
  /** when the provider was last probed */
  at: string;
  /** per model id — the exact model that answered, not a summary */
  models: Record<string, ModelHealth>;
  /** fastest successful model's latency, null when every model failed */
  best: number | null;
};

export type CatalogHealth = Record<string, ProviderHealth>;

/** The operator panel's own credentials.

    Held apart from any user account on purpose: the panel is a separate door,
    so losing a user password or being blocked as a user cannot take the
    platform's controls away, and an operator does not need a second account in
    the product to administer it. Only hashes are stored — the plaintext exists
    the moment it is typed and never again. `code` is an optional second factor:
    null means the login asks for nothing beyond the password. */
export type AdminAuthConfig = {
  username: string;
  passwordHash: string;
  /** optional extra code the login must also get right */
  codeHash: string | null;
  /** bumped on every credential change, so old sessions stop being accepted */
  generation: number;
  updatedAt: string;
};

export type PlatformData = {
  providers: ProviderEntry[];
  /** what the last Test found, keyed by provider id */
  health?: CatalogHealth;
  /** the panel's own login, once an operator has set one */
  admin?: AdminAuthConfig | null;
  infra: InfraEntry;
  /** which tier each plan routes to — the operator's switch */
  policy: Record<PlanId, ModelTier>;
  /** credit economy — both values in milli-USD, editable in the admin panel */
  credits: {
    /** what 1,000,000 tokens cost a user, e.g. 1000 = $1.00 */
    pricePerMillionMilli: number;
    /** the grant a new account starts with, e.g. 10000 = $10.00 */
    freeGrantMilli: number;
  };
};

export const DEFAULT_FREE_GRANT_MILLI = 10_000; // $10.00
export const DEFAULT_PRICE_PER_MILLION_MILLI = 1_000; // $1.00 / 1M tokens

/* The env-configured providers, used until an operator edits the catalog. All of
   these speak the OpenAI chat-completions dialect, so one client covers them.

   The failover order is `priority`, highest first — see the field's own comment
   for why it is explicit rather than implied by array position. The shape of it:

     100  1412 (TrueModel)  — the only provider whose models were individually
                              benchmarked, ordered by measured throughput. This
                              is the one a run is *supposed* to use.
      60  Google AI Studio  — strong quality, generous free tier. The intended
                              second rung.
      55  HCNSEC            — verified 2026-10-07; carries DeepSeek/GLM/Qwen.
      50  Aion Labs         — verified 2026-10-07; uncensored catalog.
      40  NVIDIA NIM        — capable, slower.
      30  Cerebras
      20  OpenRouter
      10  Groq              — LAST RESORT, deliberately.

   Groq sits at the bottom on purpose. It is fast, but its free catalog is a
   single small open model, and a product brief or a codebase written by it is
   visibly weaker than one from the rungs above. Being fast is not the same as
   being good, and for this pipeline quality of instruction-following is what
   matters. It stays in the chain because having a rung that answers is better
   than having none — but only after every better option has been tried. */
const ENV_DEFAULTS: ProviderEntry[] = [
  {
    id: TRUE_PROVIDER.id,
    label: TRUE_PROVIDER.label,
    baseUrl: TRUE_PROVIDER.baseUrl,
    keyEncrypted: null,
    keyEnv: TRUE_PROVIDER.keyEnv,
    models: TRUE_MODEL_IDS,
    tier: "free",
    enabled: true,
    priority: 100,
    /* Per-agent pins. The spec and prompt agents are the ones that write prose
       an operator has to read, and gemini-3.6-flash is the fastest model in
       this catalog that holds a long instruction together (48.8 t/s at 1.2s,
       measured). Pinning them keeps the checkpoint's output stable run to run
       instead of following whatever the failover chain happened to land on.
       A pin is still only a preference: the chain stands behind it. */
    agents: { spec: "gemini-3.6-flash", prompt: "gemini-3.6-flash" },
    notes: TRUE_PROVIDER.notes,
  },
  {
    id: "gemini",
    label: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEncrypted: null,
    keyEnv: "GEMINI_API_KEY",
    /* Measured 2026-10-08 against this account's key: 2.5-flash answers 404
       (“no longer available to new users”) and so does 2.5-flash-lite, while
       these three answer in 2–3s. A retired default is not a neutral mistake —
       it burns a rung of every failover cascade that reaches this provider. */
    models: ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-flash-lite-latest"],
    tier: "free",
    enabled: true,
    priority: 60,
    agents: {},
    notes: "generous free tier, no card, 1M context",
  },
  {
    id: HCNSEC_PROVIDER.id,
    label: HCNSEC_PROVIDER.label,
    baseUrl: HCNSEC_PROVIDER.baseUrl,
    keyEncrypted: null,
    keyEnv: HCNSEC_PROVIDER.keyEnv,
    models: HCNSEC_MODEL_IDS,
    tier: "free",
    enabled: true,
    priority: 55,
    agents: {},
    notes: HCNSEC_PROVIDER.notes,
  },
  {
    id: AION_PROVIDER.id,
    label: AION_PROVIDER.label,
    baseUrl: AION_PROVIDER.baseUrl,
    keyEncrypted: null,
    keyEnv: AION_PROVIDER.keyEnv,
    models: AION_MODEL_IDS,
    tier: "free",
    enabled: true,
    priority: 50,
    agents: {},
    notes: AION_PROVIDER.notes,
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEncrypted: null,
    keyEnv: "NVIDIA_API_KEY",
    /* NVIDIA rotates this catalog hard: the previous default
       (nvidia/llama-3.3-nemotron-super-49b-v1) now answers 410, and the first
       four replacements answered 410, 404 or nothing within 25s. These two at
       least exist on the account today, and they are slow — which is why this
       provider sits low in the order and why the panel's Test button is the
       right way to pick a model here rather than trusting a list. */
    models: ["deepseek-ai/deepseek-v4.1-flash", "google/gemma-4-31b-it"],
    tier: "free",
    enabled: true,
    priority: 40,
    agents: {},
    notes: "models rotate — test before relying on it",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    keyEncrypted: null,
    keyEnv: "CEREBRAS_API_KEY",
    models: ["llama-3.3-70b"],
    tier: "free",
    enabled: true,
    priority: 30,
    agents: {},
    notes: "~1M tokens/day free",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEncrypted: null,
    keyEnv: "OPENROUTER_API_KEY",
    models: ["openrouter/free", "meta-llama/llama-3.3-70b-instruct:free"],
    tier: "free",
    enabled: true,
    priority: 20,
    agents: {},
    notes: "':free' catalog plus a free router",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEncrypted: null,
    keyEnv: "GROQ_API_KEY",
    /* Measured 2026-10-08: qwen3.8-27b answers in 171ms, gpt-oss-120b in 505ms.
       It stays last in the default order — being fast is not the same as being
       good — but it is a real answering rung, and auto-arrange is free to move
       it up the moment measurements say so. */
    models: ["qwen/qwen3.8-27b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    tier: "free",
    enabled: true,
    priority: 10,
    agents: {},
    notes: "last resort — fast, but the weakest free model in the chain",
  },
];

function defaults(): PlatformData {
  return {
    providers: ENV_DEFAULTS,
    health: {},
    admin: null,
    infra: {
      githubTokenEncrypted: null,
      vercelTokenEncrypted: null,
      vercelTeamId: process.env.VERCEL_TEAM_ID ?? null,
    },
    policy: { free: "free", pro: "premium" },
    credits: {
      pricePerMillionMilli: DEFAULT_PRICE_PER_MILLION_MILLI,
      freeGrantMilli: DEFAULT_FREE_GRANT_MILLI,
    },
  };
}

/* A short cache: this row is read on nearly every page and changes rarely.
   Invalidated on save, and refreshed at most once a minute in a long-lived
   worker. */
let cached: { at: number; data: PlatformData } | null = null;
const TTL_MS = 60_000;

export async function getPlatformData(): Promise<PlatformData> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;

  let data: PlatformData;
  try {
    const [row] = await db
      .select()
      .from(platformSettings)
      .where(eq(platformSettings.id, "app"))
      .limit(1);
    data = row ? mergeWithDefaults(row.data as Partial<PlatformData>) : defaults();
  } catch {
    /* A settings read must never take a page down. Falling back to the
       env-configured defaults degrades to a working pipeline. */
    data = defaults();
  }

  cached = { at: Date.now(), data };
  return data;
}

/** New catalog fields must appear for rows written by an older version. */
function mergeWithDefaults(stored: Partial<PlatformData>): PlatformData {
  const base = defaults();
  /* A provider row written before `priority` existed has no value for it, and
     defaulting every one of them to the same number would silently restore the
     array-order behaviour this field was added to replace. So the default comes
     from the built-in catalog by id: an old row inherits the intent that was
     already intended for it, and only a provider we do not recognise falls back
     to 0 (i.e. last). */
  const knownPriority = new Map(base.providers.map((p) => [p.id, p.priority]));

  return {
    providers:
      Array.isArray(stored.providers) && stored.providers.length > 0
        ? stored.providers.map((p) => ({
            ...p,
            priority: typeof p.priority === "number" ? p.priority : (knownPriority.get(p.id) ?? 0),
            agents: p.agents ?? {},
          }))
        : base.providers,
    infra: { ...base.infra, ...(stored.infra ?? {}) },
    policy: { ...base.policy, ...(stored.policy ?? {}) },
    health: stored.health ?? {},
    admin: stored.admin ?? null,
    credits: {
      ...base.credits,
      ...(stored.credits ?? {}),
      /* a config row written before pricing existed must not read as $0 */
      pricePerMillionMilli:
        typeof stored.credits?.pricePerMillionMilli === "number"
          ? stored.credits.pricePerMillionMilli
          : base.credits.pricePerMillionMilli,
      freeGrantMilli:
        typeof stored.credits?.freeGrantMilli === "number"
          ? stored.credits.freeGrantMilli
          : base.credits.freeGrantMilli,
    },
  };
}

export async function savePlatformData(data: PlatformData): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ id: "app", data, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: { data, updatedAt: new Date() },
    });
  cached = null;
}

export async function updatePlatformData(
  patch: (current: PlatformData) => PlatformData,
): Promise<PlatformData> {
  const next = patch(await getPlatformData());
  await savePlatformData(next);
  return next;
}

/* ————————————————————————— resolution ————————————————————————— */

export type ResolvedProvider = {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  tier: ModelTier;
  priority: number;
  agents: Partial<Record<AgentId, string>>;
};

/** The providers a given plan tier may use, with keys resolved and empty ones
    dropped.

    Two orderings matter here and they are different things:

      · `priority` decides which PROVIDER is reached for first — see the field.
      · the returned array is sorted by it, so a caller that just walks the list
        walks the intended failover order.

    A provider whose key does not resolve is dropped entirely rather than tried
    and failed: an unconfigured rung is not a rung. That is also why a missing
    1412 key silently demotes the whole chain to the next provider down — the
    caller sees no error, just a weaker model. */
export async function resolveProviders(tier: ModelTier): Promise<ResolvedProvider[]> {
  const { providers } = await getPlatformData();

  return providers
    .filter((p) => p.enabled && p.tier === tier)
    .map((p) => {
      const apiKey = p.keyEncrypted
        ? decryptSecret(p.keyEncrypted) ?? ""
        : (process.env[p.keyEnv ?? ""] ?? "").trim();
      return {
        id: p.id,
        label: p.label,
        baseUrl: p.baseUrl,
        apiKey,
        models: p.models,
        tier: p.tier,
        priority: p.priority,
        agents: p.agents,
      };
    })
    .filter((p) => p.apiKey.length > 0 && p.models.length > 0)
    .sort((a, b) => b.priority - a.priority);
}

/** The providers this tier CAN use but has no key for, by label.

    `resolveProviders` drops them silently, which is right for the chain and
    wrong for the operator: "why did it never try Groq / NVIDIA / Aion?" has no
    answer anywhere in the run log, because the provider was never in the chain
    to fail. This makes the absence reportable instead of invisible. */
export async function unkeyedProviders(tier: ModelTier): Promise<string[]> {
  const { providers } = await getPlatformData();
  return providers
    .filter((p) => p.enabled && p.tier === tier)
    .filter((p) => {
      const apiKey = p.keyEncrypted
        ? decryptSecret(p.keyEncrypted) ?? ""
        : (process.env[p.keyEnv ?? ""] ?? "").trim();
      return apiKey.length === 0 || p.models.length === 0;
    })
    .map((p) => `${p.label} (no key${p.keyEnv ? ` — set ${p.keyEnv}` : ""})`);
}

/** The operator token for an infrastructure service, falling back to the
    environment. Returns null when neither is configured — callers decide
    whether that is fatal (deploy) or merely degraded (repo creation). */
export async function resolveInfraToken(which: "github" | "vercel"): Promise<string | null> {
  const { infra } = await getPlatformData();
  const stored = which === "github" ? infra.githubTokenEncrypted : infra.vercelTokenEncrypted;
  const fromSettings = decryptSecret(stored);
  if (fromSettings) return fromSettings;

  const env = which === "github" ? process.env.GITHUB_TOKEN : process.env.VERCEL_TOKEN;
  return env?.trim() || null;
}

export async function setInfraToken(
  which: "github" | "vercel",
  plaintext: string | null,
): Promise<void> {
  await updatePlatformData((current) => ({
    ...current,
    infra: {
      ...current.infra,
      ...(which === "github"
        ? { githubTokenEncrypted: plaintext ? encryptSecret(plaintext) : null }
        : { vercelTokenEncrypted: plaintext ? encryptSecret(plaintext) : null }),
    },
  }));
}

/* ————————————————————————— safe views ————————————————————————— */

export type SafeProvider = Omit<ProviderEntry, "keyEncrypted"> & {
  hasKey: boolean;
  /** set when the key comes from an env var rather than the panel */
  keyFromEnv: boolean;
};

export function toSafeProvider(p: ProviderEntry): SafeProvider {
  const { keyEncrypted, ...rest } = p;
  return {
    ...rest,
    hasKey: Boolean(keyEncrypted) || Boolean(process.env[p.keyEnv ?? ""]?.trim()),
    keyFromEnv: !keyEncrypted && Boolean(process.env[p.keyEnv ?? ""]?.trim()),
  };
}
