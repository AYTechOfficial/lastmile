"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { addUserProvider, deleteUserProvider, toggleUserProvider } from "@/lib/platform/user-providers";
import { clearVercelConnection, saveVercelConnection, verifyVercelToken } from "@/lib/platform/vercel";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return session.user.id;
}

export async function addUserProviderAction(formData: FormData) {
  const userId = await requireUserId();
  const label = String(formData.get("label") ?? "").trim() || "My endpoint";
  const baseUrl = String(formData.get("baseUrl") ?? "").trim();
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const models = String(formData.get("models") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!/^https?:\/\//i.test(baseUrl) || !apiKey || models.length === 0) return;
  await addUserProvider(userId, { label, baseUrl, apiKey, models });
  revalidatePath("/dashboard/settings");
}

export async function deleteUserProviderAction(formData: FormData) {
  const userId = await requireUserId();
  const id = String(formData.get("id") ?? "");
  if (id) await deleteUserProvider(userId, id);
  revalidatePath("/dashboard/settings");
}

export async function toggleUserProviderAction(formData: FormData) {
  const userId = await requireUserId();
  const id = String(formData.get("id") ?? "");
  if (id) await toggleUserProvider(userId, id);
  revalidatePath("/dashboard/settings");
}

/* Connect Vercel — the user's own deploy target. The token is verified
   against /v2/user BEFORE it is stored, and saved encrypted; the plaintext
   is never echoed back. */
export async function connectVercelAction(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const userId = await requireUserId();
  const token = String(formData.get("token") ?? "").trim();
  const teamId = String(formData.get("teamId") ?? "").trim();
  if (!token) return { ok: false, error: "Paste a Vercel token first" };

  const check = await verifyVercelToken(token);
  if (!check.ok) return { ok: false, error: check.error };

  await saveVercelConnection(userId, token, teamId || null, check.username);
  revalidatePath("/dashboard/settings");
  return { ok: true };
}

export async function disconnectVercelAction(): Promise<{ ok: boolean }> {
  const userId = await requireUserId();
  await clearVercelConnection(userId);
  revalidatePath("/dashboard/settings");
  return { ok: true };
}
