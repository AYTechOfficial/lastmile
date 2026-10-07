"use server";

import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { rateLimit } from "@/lib/rate-limit";
import { grantCredits } from "@/lib/credits";
import { getPlatformData } from "@/lib/platform/settings";

export type AuthFormState = { error?: string; ok?: boolean };

/* Creating an account.

   Two things are deliberate:

   · The password is hashed with bcrypt before it touches the database, and the
     cost factor is the library default — no hand-rolled hashing.
   · Failures return a message to the form rather than throwing, so a taken
     email reads as a form error and not as a server error page. */

const MIN_PASSWORD = 8;

export async function signUpAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const name = String(formData.get("name") ?? "").trim().slice(0, 80);
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  /* Account creation is the most attractive thing to script, so it is limited
     before any work happens. */
  const limited = await rateLimit(`signup:${email}`, 5, 60_000);
  if (!limited.ok) {
    return { error: "Too many attempts. Wait a minute and try again." };
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: "Enter a valid email address." };
  }
  if (password.length < MIN_PASSWORD) {
    return { error: `Use at least ${MIN_PASSWORD} characters for your password.` };
  }

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    return { error: "That email already has an account. Sign in instead." };
  }

  const passwordHash = await bcrypt.hash(password, 10);

  /* The signup grant is the operator's number (admin → credits), not a
     constant: it is credited through the ledger so the new account opens with
     a balance it can explain — every dollar traceable to a grant row. */
  const { credits: pricing } = await getPlatformData();

  const [created] = await db
    .insert(users)
    .values({
      name: name || email.split("@")[0],
      email,
      passwordHash,
      /* New accounts start on the free plan; Pro is assigned by an operator. */
      plan: "free",
      creditsMilli: 0,
    })
    .returning({ id: users.id });

  if (created) {
    await grantCredits(created.id, pricing.freeGrantMilli, "grant:signup");
  }

  redirect("/login?created=1");
}
