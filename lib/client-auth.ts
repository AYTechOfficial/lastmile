"use client";

/* Sign-in, sign-out and OAuth for the browser.

   The previous build carried a hand-rolled CSRF-and-fetch implementation here,
   because on Zoho Catalyst AppSail calling `signIn()` from a server action made
   the container fetch its own auth endpoints through a proxy that did not route
   them — surfacing to users as a cryptic React error on the login form.

   That workaround is gone, along with the platform that required it. On Vercel
   `signIn`/`signOut` from next-auth/react are the correct, supported path, and
   they handle CSRF, cookies and redirects properly.

   The exported names are unchanged so the existing forms keep working. */

import { signIn, signOut } from "next-auth/react";

export type DirectSignInResult = {
  ok: boolean;
  error?: string;
  /** where the caller should navigate once the session cookie is set */
  redirectTo?: string;
};

export async function directCredentialsSignIn(
  email: string,
  password: string,
  callbackUrl = "/dashboard",
): Promise<DirectSignInResult> {
  try {
    const result = await signIn("credentials", { email, password, redirect: false });
    if (!result || result.error) {
      return { ok: false, error: "Invalid email or password." };
    }
    /* Navigation belongs to the caller, which owns the router — pushing keeps
       the client cache warm instead of throwing it away with a full reload.
       The session cookie is already set by this point. */
    return { ok: true, redirectTo: callbackUrl };
  } catch {
    return { ok: false, error: "Could not reach the sign-in endpoint — check your connection." };
  }
}

/** OAuth must be a real browser navigation, not a router push: the destination
    is the provider's own domain. next-auth performs that navigation itself. */
export async function directOAuthSignIn(
  provider: "github",
  callbackUrl = "/dashboard",
): Promise<DirectSignInResult> {
  try {
    await signIn(provider, { callbackUrl });
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not start GitHub sign-in — try again." };
  }
}

export async function directSignOut(): Promise<void> {
  /* A full reload on sign-out is deliberate: a client-side push would leave the
     previous session's cached server payloads in place. */
  await signOut({ callbackUrl: "/" });
}
