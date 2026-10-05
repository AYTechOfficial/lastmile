import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { platformSettings, users } from "@/lib/schema";
import { decryptSecret, maskKey } from "@/lib/crypto";

/* Platform settings — the Admin page's backing store, one singleton row.

   What lives here (all server-side only, keys encrypted):
     providers[] — every model endpoint the platform may call: label, base
                   URL, key (ciphertext), models, per-plan + per-agent
                   assignment, enabled flag.
     infra       — GitHub token (repo creation) and Vercel/Render tokens
                   (deploys) when the operator chooses to supply them here.
   The client never receives ciphertext — only labels, masks, and models. */

export type AgentId =
  | "research"
  | "prompt"
  | "code"
  | "verify"
  | "deploy"
  | "test"
  | "orchestrator";

export const AGENT_IDS: AgentId[] = ["research", "prompt", "code", "verify", "deploy", "test"];

export type PlanId = "free" | "pro";

export type ProviderEntry = {
  id: string;
  label: string;
  baseUrl: string;
  /** AES-256-GCM ciphertext — never leaves the server */
  keyEncrypted: string;
  models: string[];
  enabled: boolean;
  /** which plan this provider serves; a provider can serve both */
  plans: PlanId[];
  /** null = any agent; otherwise this provider is reserved for one agent */
  agent: AgentId | null;
  createdAt: string;
};

export type InfraEntry = {
  githubTokenEncrypted: string | null;
  vercelTokenEncrypted: string | null;
  renderTokenEncrypted: string | null;
};

export type PlatformData = {
  providers: ProviderEntry[];
  infra: InfraEntry;
};

const SETTINGS_ID = "app";

const EMPTY: PlatformData = {
  providers: [],
  infra: { githubTokenEncrypted: null, vercelTokenEncrypted: null, renderTokenEncrypted: null },
};

export async function getPlatformData(): Promise<PlatformData> {
  const [row] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.id, SETTINGS_ID))
    .limit(1);
  if (!row) return structuredClone(EMPTY);
  const data = row.data as Partial<PlatformData>;
  return {
    providers: Array.isArray(data.providers) ? data.providers : [],
    infra: { ...EMPTY.infra, ...(data.infra ?? {}) },
  };
}

export async function savePlatformData(data: PlatformData): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ id: SETTINGS_ID, data, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: { data, updatedAt: new Date() },
    });
}

export async function updatePlatformData(
  fn: (data: PlatformData) => PlatformData,
): Promise<PlatformData> {
  const current = await getPlatformData();
  const next = fn(current);
  await savePlatformData(next);
  return next;
}

/* ———————————————————————— decryption ———————————————————————— */

/** The resolved credential set the agents may use. Server-side only. */
export type ResolvedProvider = {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
};

export async function resolveProviders(plan: PlanId): Promise<ResolvedProvider[]> {
  const data = await getPlatformData();
  const out: ResolvedProvider[] = [];
  for (const p of data.providers) {
    if (!p.enabled) continue;
    if (!p.plans.includes(plan)) continue;
    const key = decryptSecret(p.keyEncrypted);
    if (!key) continue;
    out.push({
      id: p.id,
      label: p.label,
      baseUrl: p.baseUrl,
      apiKey: key,
      models: p.models.filter(Boolean),
    });
  }
  return out;
}

export async function resolveInfraToken(
  which: "github" | "vercel" | "render",
): Promise<string | null> {
  const data = await getPlatformData();
  const field =
    which === "github"
      ? data.infra.githubTokenEncrypted
      : which === "vercel"
        ? data.infra.vercelTokenEncrypted
        : data.infra.renderTokenEncrypted;
  return field ? decryptSecret(field) : null;
}

/* ———————————————————————— admin gate ———————————————————————— */

/** Who may open /admin.
 *
 *  ADMIN_EMAILS configured → exactly those emails, and nobody else.
 *  ADMIN_EMAILS unset      → single-operator install: ONLY the first account
 *    ever created is the operator.
 *
 *  The previous behaviour returned true for everyone when the list was unset,
 *  which handed every new sign-up the Admin panel and the ability to promote
 *  any account to Pro. That was a privilege-escalation bug. */
export async function isAdminEmail(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  const list = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length > 0) return list.includes(email.toLowerCase());

  try {
    const [first] = await db
      .select({ email: users.email })
      .from(users)
      .orderBy(asc(users.createdAt))
      .limit(1);
    return !!first?.email && first.email.toLowerCase() === email.toLowerCase();
  } catch {
    return false; // fail closed: an unreadable user table grants nobody admin
  }
}

/* ———————————————————————— safe view ———————————————————————— */

/** What the Admin UI renders: everything except the ciphertext itself. */
export type SafeProvider = {
  id: string;
  label: string;
  baseUrl: string;
  keyMask: string | null;
  models: string[];
  enabled: boolean;
  plans: PlanId[];
  agent: AgentId | null;
  createdAt: string;
};

export function toSafeProvider(p: ProviderEntry): SafeProvider {
  return {
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    keyMask: maskKey(decryptSecret(p.keyEncrypted) ?? ""),
    models: p.models,
    enabled: p.enabled,
    plans: p.plans,
    agent: p.agent,
    createdAt: p.createdAt,
  };
}
