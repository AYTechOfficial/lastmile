"use server";

import bcrypt from "bcryptjs";
import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { auth, unstable_update } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { emailChangedEmail, passwordChangedEmail, sendMail } from "@/lib/mail";

/* Profile — the account a user can actually run.

   Three honest operations:
     · name + avatar      — cosmetic, no secrets, updates the live session
     · email change       — requires the current password, notifies the OLD
                            address so a hijack is visible where it hurts
     · password change    — requires the current password, notifies the
                            account address

   The mail wing is best-effort by design: when no provider is configured the
   change still happens, but the UI says the notice could not be emailed
   rather than claiming it was. */

export type ProfileResult = { ok: boolean; error?: string; notice?: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_MIN = 2;
const NAME_MAX = 60;
/** ~500 KB binary → ~680 KB base64. Server actions cap bodies at 1 MB. */
const AVATAR_MAX_BYTES = 500 * 1024;

function mailNotice(result: { sent: boolean; reason?: string }): string | undefined {
  if (result.sent) return "Confirmation email sent.";
  if (result.reason === "no-mail-provider") {
    return "Email delivery is not configured on this deployment — no notice was sent.";
  }
  return "The confirmation email could not be delivered.";
}

async function currentUser() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  return user ?? null;
}

/* ————— name + avatar ————— */

export async function updateProfileAction(
  _prev: ProfileResult,
  formData: FormData,
): Promise<ProfileResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const name = String(formData.get("name") ?? "").trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return { ok: false, error: `Name must be ${NAME_MIN}-${NAME_MAX} characters.` };
  }

  let image = user.image;
  const file = formData.get("avatar");
  if (file instanceof File && file.size > 0) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      return { ok: false, error: "Avatar must be a PNG, JPEG or WebP image." };
    }
    if (file.size > AVATAR_MAX_BYTES) {
      return { ok: false, error: "Avatar must be under 500 KB." };
    }
    const buf = Buffer.from(await file.arrayBuffer());
    image = `data:${file.type};base64,${buf.toString("base64")}`;
  }

  await db.update(users).set({ name, image }).where(eq(users.id, user.id));
  await unstable_update({ user: { name, image } });

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard");
  return { ok: true, notice: "Profile updated." };
}

/* ————— email ————— */

export async function updateEmailAction(
  _prev: ProfileResult,
  formData: FormData,
): Promise<ProfileResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const newEmail = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!EMAIL_RE.test(newEmail)) return { ok: false, error: "That is not a valid email address." };
  if (newEmail === (user.email ?? "").toLowerCase()) {
    return { ok: false, error: "That is already your email." };
  }
  if (!user.passwordHash) {
    return { ok: false, error: "This account signs in with GitHub — the email comes from GitHub." };
  }
  if (!password) return { ok: false, error: "Confirm your current password to change your email." };

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return { ok: false, error: "Current password is wrong." };

  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, newEmail), ne(users.id, user.id)))
    .limit(1);
  if (taken) return { ok: false, error: "That email is already in use by another account." };

  const oldEmail = user.email!;
  await db.update(users).set({ email: newEmail, emailVerified: null }).where(eq(users.id, user.id));
  await unstable_update({ user: { email: newEmail } });

  const mail = await sendMail(oldEmail, emailChangedEmail(oldEmail, newEmail).subject, emailChangedEmail(oldEmail, newEmail).html);

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard");
  return { ok: true, notice: mailNotice(mail) ?? undefined };
}

/* ————— password ————— */

export async function changePasswordAction(
  _prev: ProfileResult,
  formData: FormData,
): Promise<ProfileResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!user.passwordHash) {
    return { ok: false, error: "This account signs in with GitHub — it has no password to change." };
  }
  if (next.length < 8) return { ok: false, error: "The new password must be at least 8 characters." };
  if (next !== confirm) return { ok: false, error: "The new passwords do not match." };

  const ok = await bcrypt.compare(current, user.passwordHash);
  if (!ok) return { ok: false, error: "Current password is wrong." };

  const hash = await bcrypt.hash(next, 12);
  await db.update(users).set({ passwordHash: hash }).where(eq(users.id, user.id));

  const mail = user.email
    ? await sendMail(user.email, passwordChangedEmail().subject, passwordChangedEmail().html)
    : { sent: false };

  revalidatePath("/dashboard/settings");
  return { ok: true, notice: mailNotice(mail) ?? undefined };
}
