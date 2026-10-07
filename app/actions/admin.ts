"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { auth, isAdminEmail } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { updatePlatformData } from "@/lib/platform/settings";
import { grantCredits } from "@/lib/credits";

/* Operator-only actions. Every one re-checks the admin email server-side —
   the admin NAV being hidden in the shell is presentation, not security. */

async function requireAdmin(): Promise<string | null> {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!session?.user?.id || !isAdminEmail(email)) return null;
  return session.user.id;
}

export type AdminResult = { ok: boolean; error?: string; notice?: string };

/** Set the credit economy: price per 1M tokens and the signup grant. */
export async function setCreditPricingAction(
  _prev: AdminResult,
  formData: FormData,
): Promise<AdminResult> {
  if (!(await requireAdmin())) return { ok: false, error: "Admins only." };

  const price = Number(String(formData.get("pricePerMillion") ?? ""));
  const grant = Number(String(formData.get("freeGrant") ?? ""));

  if (!Number.isFinite(price) || price < 0 || price > 1000) {
    return { ok: false, error: "Price per million must be between $0 and $1000." };
  }
  if (!Number.isFinite(grant) || grant < 0 || grant > 1000) {
    return { ok: false, error: "The signup grant must be between $0 and $1000." };
  }

  await updatePlatformData((current) => ({
    ...current,
    credits: {
      pricePerMillionMilli: Math.round(price * 1000),
      freeGrantMilli: Math.round(grant * 1000),
    },
  }));

  revalidatePath("/admin");
  revalidatePath("/dashboard");
  return { ok: true, notice: "Pricing saved — the next stage charge uses it." };
}

/** Top up (or claw back, with a negative amount) a user's credits by email. */
export async function grantCreditsAction(
  _prev: AdminResult,
  formData: FormData,
): Promise<AdminResult> {
  if (!(await requireAdmin())) return { ok: false, error: "Admins only." };

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const amount = Number(String(formData.get("amount") ?? ""));

  if (!email) return { ok: false, error: "Give the account's email." };
  if (!Number.isFinite(amount) || amount === 0) {
    return { ok: false, error: "Give an amount in dollars (negative to claw back)." };
  }

  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) return { ok: false, error: `No account for ${email}.` };

  const amountMilli = Math.round(amount * 1000);
  const { balanceMilli } = await grantCredits(user.id, amountMilli, "grant:admin");

  revalidatePath("/admin");
  revalidatePath("/dashboard");
  return {
    ok: true,
    notice: `${amount > 0 ? "Granted" : "Clawed back"} $${Math.abs(amount).toFixed(2)} ${amount > 0 ? "to" : "from"} ${email} — new balance $${(balanceMilli / 1000).toFixed(2)}.`,
  };
}
