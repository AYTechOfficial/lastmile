import { eq } from "drizzle-orm";
import { db } from "../db";
import { platformSettings } from "../schema";
import { decryptSecret, encryptSecret } from "../crypto";
import type { ModelTier, PlanId } from "../plans";
import { TRUE_MODEL_IDS, TRUE_PROVIDER } from "../ai/catalog";

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
  /** per-agent model pins — the code agent can run a different model to research */
  agents: Partial<Record<AgentId, string>>;
  notes: string | null;
};

export type InfraEntry = {
  githubTokenEncrypted: string | null;
  vercelTokenEncrypted: string | null;
  vercelTeamId: string | null;
};

export type PlatformData = {
  providers: ProviderEntry[];
  infra: InfraEntry;
  /** which tier each plan routes to — the operator's switch */
  policy: Record<PlanId, ModelTier>;
};

/* The env-configured providers, used until an operator edits the catalog. All of
   these speak the OpenAI chat-completions dialect, so one client covers them.

   ORDER IS THE FAILOVER ORDER, and the first entry is the one a free run leads
   with. 1412 (TrueModel) sits first because it is the only rung whose models
   were individually benchmarked — its list is ordered by measured throughput,
   fastest first, and the rest of the chain stands behind it. */
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
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEncrypted: null,
    keyEnv: "GROQ_API_KEY",
    models: ["openai/gpt-oss-120b"],
    tier: "free",
    enabled: true,
    agents: {},
    notes: "30 req/min free, fastest tokens/sec",
  },
  {
    id: "gemini",
    label: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEncrypted: null,
    keyEnv: "GEMINI_API_KEY",
    models: ["gemini-2.5-flash"],
    tier: "free",
    enabled: true,
    agents: {},
    notes: "generous free tier, no card, 1M context",
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
    agents: {},
    notes: "~1M tokens/day free",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEncrypted: null,
    keyEnv: "NVIDIA_API_KEY",
    models: ["nvidia/llama-3.3-nemotron-super-49b-v1"],
    tier: "free",
    enabled: true,
    agents: {},
    notes: "40 req/min, hosted by NVIDIA",
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
    agents: {},
    notes: "':free' catalog plus a free router",
  },
];

function defaults(): PlatformData {
  return {
    providers: ENV_DEFAULTS,
    infra: {
      githubTokenEncrypted: null,
      vercelTokenEncrypted: null,
      vercelTeamId: process.env.VERCEL_TEAM_ID ?? null,
    },
    policy: { free: "free", pro: "premium" },
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
  return {
    providers: Array.isArray(stored.providers) && stored.providers.length > 0
      ? stored.providers.map((p) => ({ ...p, agents: p.agents ?? {} }))
      : base.providers,
    infra: { ...base.infra, ...(stored.infra ?? {}) },
    policy: { ...base.policy, ...(stored.policy ?? {}) },
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
  agents: Partial<Record<AgentId, string>>;
};

/** The providers a given plan tier may use, with keys resolved and empty ones
    dropped. Order is catalog order, which is the failover order. */
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
        agents: p.agents,
      };
    })
    .filter((p) => p.apiKey.length > 0 && p.models.length > 0);
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
