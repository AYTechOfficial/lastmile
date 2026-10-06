"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import {
  addUserProvider,
  deleteUserProvider,
  toggleUserProvider,
} from "@/lib/platform/user-providers";
import {
  clearUserCredential,
  resolveServiceCredential,
  setUserCredential,
  type ServiceId,
} from "@/lib/platform/services";
import { probeService } from "@/lib/platform/probe";

/* Settings — the two things a user can attach to their own account:

     · model endpoints, so a key they pay for beats the platform's
     · service credentials, so projects are created and deployed under their
       own GitHub and Vercel rather than the operator's

   Every value is encrypted before storage, verified against the real service
   before it is accepted, and never echoed back in plaintext.

   Note what is NOT here: any way for a user to read, list or edit the platform's
   own defaults. Those live in server-side config and the admin panel. A user can
   only replace a default with their own key, or remove their key and fall back. */

async function currentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

/* ————————————————————————— model providers ————————————————————————— */

export async function addUserProviderAction(formData: FormData): Promise<void> {
  const userId = await currentUserId();
  if (!userId) return;

  const label = String(formData.get("label") ?? "").trim();
  const baseUrl = String(formData.get("baseUrl") ?? "").trim();
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const models = String(formData.get("models") ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  if (!label || !baseUrl || !apiKey || models.length === 0) return;

  /* https only: this key is sent to that URL, so plain http would leak it. */
  if (!/^https:\/\//i.test(baseUrl)) return;

  await addUserProvider(userId, { label, baseUrl, apiKey, models });
  revalidatePath("/dashboard/settings");
}

export async function deleteUserProviderAction(formData: FormData): Promise<void> {
  const userId = await currentUserId();
  if (!userId) return;
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await deleteUserProvider(userId, id);
  revalidatePath("/dashboard/settings");
}

export async function toggleUserProviderAction(formData: FormData): Promise<void> {
  const userId = await currentUserId();
  if (!userId) return;
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await toggleUserProvider(userId, id);
  revalidatePath("/dashboard/settings");
}

/* ————————————————————————— service credentials ————————————————————————— */

const SERVICE_IDS: ServiceId[] = ["github", "vercel", "render", "search", "browser"];

function asServiceId(value: string): ServiceId | null {
  return SERVICE_IDS.includes(value as ServiceId) ? (value as ServiceId) : null;
}

export type ConnectResult = { ok: boolean; error?: string; label?: string | null };

/** Connect the user's own account for a service.
    The key is probed against the service BEFORE it is stored, so a bad key is a
    form error rather than a failed run later. */
export async function connectServiceAction(
  formData: FormData,
): Promise<ConnectResult> {
  const userId = await currentUserId();
  if (!userId) return { ok: false, error: "Sign in first." };

  const service = asServiceId(String(formData.get("service") ?? ""));
  if (!service) return { ok: false, error: "Unknown service." };

  const value = String(formData.get("token") ?? formData.get("value") ?? "").trim();
  if (!value) return { ok: false, error: "Paste a key first." };

  const probe = await probeService(service, value);
  if (!probe.ok) {
    return { ok: false, error: probe.detail ?? "That key was rejected." };
  }

  await setUserCredential(userId, service, value, probe.label ?? null);

  /* Identity metadata the UI shows next to the connection. Vercel's team id is
     a deploy-time scope rather than a secret, so it stays on the user row. */
  if (service === "vercel") {
    const teamId = String(formData.get("teamId") ?? "").trim() || null;
    await db
      .update(users)
      .set({ vercelAccount: probe.label ?? null, vercelTeamId: teamId })
      .where(eq(users.id, userId));
  }
  if (service === "github") {
    await db
      .update(users)
      .set({ githubLogin: probe.label ?? null, githubHost: "account" })
      .where(eq(users.id, userId));
  }

  revalidatePath("/dashboard/settings");
  return { ok: true, label: probe.label ?? null };
}

/** Remove the user's key and fall back to the platform's default. */
export async function disconnectServiceAction(formData: FormData): Promise<void> {
  const userId = await currentUserId();
  if (!userId) return;

  const service = asServiceId(String(formData.get("service") ?? ""));
  if (!service) return;

  await clearUserCredential(userId, service);

  if (service === "vercel") {
    await db
      .update(users)
      .set({ vercelAccount: null, vercelTeamId: null })
      .where(eq(users.id, userId));
  }
  if (service === "github") {
    await db
      .update(users)
      .set({ githubLogin: null, githubHost: "auto" })
      .where(eq(users.id, userId));
  }

  revalidatePath("/dashboard/settings");
}

/* ————————————————————————— Vercel, as the UI knows it ————————————————————————— */

export type VercelStatus = {
  connected: boolean;
  source: "user" | "platform" | null;
  account: string | null;
};

/** Whether this user deploys to their own Vercel or to the platform's. */
export async function getVercelStatus(userId: string): Promise<VercelStatus> {
  const [row] = await db
    .select({ account: users.vercelAccount })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const resolved = await resolveServiceCredential(userId, "vercel");
  return {
    connected: Boolean(resolved.value),
    source: resolved.source,
    account: resolved.source === "user" ? (row?.account ?? null) : null,
  };
}

/** Kept under its original name so the existing Connect-Vercel component works
    unchanged; it now routes through the generic credential layer. */
export async function connectVercelAction(formData: FormData): Promise<ConnectResult> {
  const fd = new FormData();
  fd.set("service", "vercel");
  fd.set("token", String(formData.get("token") ?? ""));
  fd.set("teamId", String(formData.get("teamId") ?? ""));
  return connectServiceAction(fd);
}

export async function disconnectVercelAction(): Promise<void> {
  const fd = new FormData();
  fd.set("service", "vercel");
  await disconnectServiceAction(fd);
}
