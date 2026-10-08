"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { rateLimit } from "@/lib/rate-limit";
import {
  adminAuthState,
  clearAdminSession,
  createAdminSession,
  panelAccess,
  saveAdminCredentials,
  verifyAdminCredentials,
} from "@/lib/platform/admin-auth";

export type AdminLoginState = { error?: string; notice?: string };

/** The panel's own sign-in. Throttled by address rather than by username: a
    guesser gets about six tries a minute, which is enough for a human and
    useless for a dictionary. */
export async function adminLoginAction(
  _prev: AdminLoginState,
  formData: FormData,
): Promise<AdminLoginState> {
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "unknown";

  const limited = await rateLimit(`admin-login:${ip}`, 6, 60_000);
  if (!limited.ok) {
    return { error: "Too many attempts. Wait a minute and try again." };
  }

  const state = await adminAuthState();
  if (!state.configured) {
    return {
      error: "The panel has no credentials yet. Sign in with an operator account and set them in Admin → Settings.",
    };
  }

  const result = await verifyAdminCredentials({
    username: String(formData.get("username") ?? ""),
    password: String(formData.get("password") ?? ""),
    code: String(formData.get("code") ?? ""),
  });

  if (!result.ok) {
    if (result.reason === "bad-code") return { error: "That access code is not correct." };
    return { error: "Wrong username or password." };
  }

  await createAdminSession(result.username);
  redirect("/admin");
}

export async function adminLogoutAction(): Promise<void> {
  await clearAdminSession();
  redirect("/admin/login");
}

/** Change the panel's username, password or access code. Requires a panel
    session or an operator account: this is the door's own key. */
export async function saveAdminCredentialsAction(
  _prev: AdminLoginState,
  formData: FormData,
): Promise<AdminLoginState> {
  const access = await panelAccess();
  if (!access.ok) return { error: "Sign in to the panel first." };

  const result = await saveAdminCredentials({
    username: String(formData.get("username") ?? ""),
    password: String(formData.get("password") ?? ""),
    code: String(formData.get("code") ?? ""),
    clearCode: formData.get("clearCode") === "on",
  });
  if (!result.ok) return { error: result.error };

  /* Credentials changed, so this session's generation is behind. Say so rather
     than leaving the operator on a page that will bounce them at the next
     click. */
  if (result.notice?.includes("password changed") || result.notice?.includes("access code")) {
    await clearAdminSession();
    revalidatePath("/admin");
    redirect("/admin/login?changed=1");
  }

  revalidatePath("/admin/settings");
  return { notice: result.notice };
}
