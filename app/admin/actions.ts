"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runs, users } from "@/lib/schema";
import { encryptSecret } from "@/lib/crypto";
import { isAdminEmail, updatePlatformData, type AgentId, type PlanId, type ProviderEntry } from "@/lib/platform/settings";

/* Admin mutations. Every action re-checks the gate — pages alone are not
   authorization. Plaintext keys are accepted here and immediately encrypted;
   they are never stored or echoed back. */

async function requireAdmin() {
  const session = await auth();
  if (!session?.user?.id || !(await isAdminEmail(session.user.email))) redirect("/login");
  return session;
}

export async function addProviderAction(formData: FormData) {
  await requireAdmin();
  const key = String(formData.get("apiKey") ?? "").trim();
  if (!key) return;
  const entry: ProviderEntry = {
    id: crypto.randomUUID(),
    label: String(formData.get("label") ?? "").trim() || "Provider",
    baseUrl: String(formData.get("baseUrl") ?? "").trim().replace(/\/$/, ""),
    keyEncrypted: encryptSecret(key),
    models: String(formData.get("models") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    enabled: true,
    plans: formData.getAll("plans").map(String).filter((p): p is PlanId => p === "free" || p === "pro"),
    agent: (String(formData.get("agent") ?? "any") as AgentId | "any") === "any" ? null : (String(formData.get("agent")) as AgentId),
    createdAt: new Date().toISOString(),
  };
  if (!entry.baseUrl || entry.models.length === 0 || entry.plans.length === 0) return;
  await updatePlatformData((d) => ({ ...d, providers: [...d.providers, entry] }));
  revalidatePath("/admin");
}

export async function toggleProviderAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  await updatePlatformData((d) => ({
    ...d,
    providers: d.providers.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)),
  }));
  revalidatePath("/admin");
}

export async function deleteProviderAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  await updatePlatformData((d) => ({ ...d, providers: d.providers.filter((p) => p.id !== id) }));
  revalidatePath("/admin");
}

export async function setInfraTokenAction(formData: FormData) {
  await requireAdmin();
  const which = String(formData.get("which") ?? "");
  const value = String(formData.get("value") ?? "").trim();
  await updatePlatformData((d) => ({
    ...d,
    infra: {
      ...d.infra,
      githubTokenEncrypted: which === "github" ? (value ? encryptSecret(value) : null) : d.infra.githubTokenEncrypted,
      vercelTokenEncrypted: which === "vercel" ? (value ? encryptSecret(value) : null) : d.infra.vercelTokenEncrypted,
      renderTokenEncrypted: which === "render" ? (value ? encryptSecret(value) : null) : d.infra.renderTokenEncrypted,
    },
  }));
  revalidatePath("/admin");
}

export async function setUserPlanAction(formData: FormData) {
  await requireAdmin();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const plan = String(formData.get("plan") ?? "free") === "pro" ? "pro" : "free";
  if (!email) return;
  await db.update(users).set({ plan }).where(eq(users.email, email));
  revalidatePath("/admin");
}

export async function killRunAction(formData: FormData) {
  await requireAdmin();
  const runId = String(formData.get("runId") ?? "");
  if (!runId) return;
  await db.update(runs).set({ killRequested: true }).where(eq(runs.id, runId));
  revalidatePath("/admin");
}
