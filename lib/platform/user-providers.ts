import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { userProviders } from "@/lib/schema";
import { decryptSecret, encryptSecret, maskKey } from "@/lib/crypto";

/* A user's own model endpoints — the Settings-page counterpart to Admin →
   Providers. Resolution order everywhere is:

       user's own → operator's platform providers → env-key chain

   so a key the user pays for always wins, and someone who never attached
   anything silently runs on the platform's capacity instead of failing. */

export type SafeUserProvider = {
  id: string;
  label: string;
  baseUrl: string;
  keyMask: string;
  models: string[];
  enabled: boolean;
  createdAt: string;
};

export async function listUserProviders(userId: string): Promise<SafeUserProvider[]> {
  const rows = await db
    .select()
    .from(userProviders)
    .where(eq(userProviders.userId, userId))
    .orderBy(asc(userProviders.createdAt));
  return rows.map((p) => ({
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    keyMask: maskKey(decryptSecret(p.keyEncrypted) ?? ""),
    models: Array.isArray(p.models) ? (p.models as string[]) : [],
    enabled: p.enabled,
    createdAt: p.createdAt.toISOString(),
  }));
}

/** Plaintext keys for the model chain — server-side only, never serialised. */
export async function activeUserProviders(userId: string): Promise<
  { id: string; label: string; baseUrl: string; apiKey: string; models: string[] }[]
> {
  const rows = await db
    .select()
    .from(userProviders)
    .where(and(eq(userProviders.userId, userId), eq(userProviders.enabled, true)))
    .orderBy(asc(userProviders.createdAt));
  return rows
    .map((p) => {
      const apiKey = decryptSecret(p.keyEncrypted) ?? "";
      const models = Array.isArray(p.models) ? (p.models as string[]) : [];
      return { id: "user:" + p.id, label: p.label, baseUrl: p.baseUrl, apiKey, models };
    })
    .filter((p) => p.apiKey && p.models.length > 0);
}

export async function addUserProvider(
  userId: string,
  input: { label: string; baseUrl: string; apiKey: string; models: string[] },
): Promise<SafeUserProvider> {
  const [row] = await db
    .insert(userProviders)
    .values({
      userId,
      label: input.label.slice(0, 60),
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      keyEncrypted: encryptSecret(input.apiKey),
      models: input.models,
      enabled: true,
    })
    .returning();
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.baseUrl,
    keyMask: maskKey(decryptSecret(row.keyEncrypted) ?? ""),
    models: Array.isArray(row.models) ? (row.models as string[]) : [],
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function deleteUserProvider(userId: string, id: string): Promise<void> {
  await db.delete(userProviders).where(and(eq(userProviders.userId, userId), eq(userProviders.id, id)));
}

export async function toggleUserProvider(userId: string, id: string): Promise<void> {
  const [row] = await db
    .select({ enabled: userProviders.enabled })
    .from(userProviders)
    .where(and(eq(userProviders.userId, userId), eq(userProviders.id, id)))
    .limit(1);
  if (!row) return;
  await db
    .update(userProviders)
    .set({ enabled: !row.enabled })
    .where(and(eq(userProviders.userId, userId), eq(userProviders.id, id)));
}

/* ———————————————————————— model discovery ———————————————————————— */

/** Ask an OpenAI-compatible endpoint which models it serves. Accepts the
 *  common shapes: {data:[{id}]}, {models:[{name}]} and bare string arrays. */
export async function discoverModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const root = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(root)) return { ok: false, error: "Base URL must start with http:// or https://" };
  try {
    const res = await fetch(root + "/models", {
      /* Anthropic's /models wants x-api-key + anthropic-version; every
         OpenAI-compatible endpoint ignores both, so sending them always is
         the one-request-fits-all form. */
      headers: apiKey
        ? {
            authorization: "Bearer " + apiKey,
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          }
        : {},
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} — ${text.slice(0, 160)}` };
    const j = JSON.parse(text) as { data?: { id?: string }[]; models?: { name?: string; id?: string }[] };
    const raw: string[] = j.data?.map((m) => m.id ?? "").filter(Boolean)
      ?? j.models?.map((m) => m.name ?? m.id ?? "").filter(Boolean)
      ?? (Array.isArray(j) ? (j as unknown[]).map((x) => String(x)) : []);
    const models = [...new Set(raw)].sort((a, b) => a.localeCompare(b));
    if (models.length === 0) return { ok: false, error: "The endpoint answered but listed no models" };
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 160) : "Request failed" };
  }
}
