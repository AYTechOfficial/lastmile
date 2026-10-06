import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { userProviders } from "../schema";
import { decryptSecret, encryptSecret, maskSecret } from "../crypto";

/* A user's own model endpoints — the Settings-page counterpart to the admin
   provider catalog.

   Resolution order everywhere is:

       user's own  →  operator's platform providers  →  env-key chain

   so a key the user pays for always wins, and someone who attached nothing
   quietly runs on the platform's capacity instead of seeing an error. */

export type SafeUserProvider = {
  id: string;
  label: string;
  baseUrl: string;
  keyMask: string;
  models: string[];
  enabled: boolean;
  createdAt: string;
};

/** What the UI gets — masks, never keys. */
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
    keyMask: maskSecret(decryptSecret(p.keyEncrypted)),
    models: Array.isArray(p.models) ? (p.models as string[]) : [],
    enabled: p.enabled,
    createdAt: p.createdAt.toISOString(),
  }));
}

/** Plaintext keys for the model chain. Server-side only — never serialised,
    never logged. */
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
    .filter((p) => p.apiKey.length > 0 && p.models.length > 0);
}

export async function addUserProvider(
  userId: string,
  input: { label: string; baseUrl: string; apiKey: string; models: string[] },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(userProviders)
    .values({
      userId,
      label: input.label.slice(0, 60),
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      keyEncrypted: encryptSecret(input.apiKey),
      models: input.models,
    })
    .returning({ id: userProviders.id });
  return row;
}

export async function deleteUserProvider(userId: string, id: string): Promise<void> {
  await db
    .delete(userProviders)
    .where(and(eq(userProviders.userId, userId), eq(userProviders.id, id)));
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
