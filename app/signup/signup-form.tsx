"use client";

import { useEffect, useRef, useState } from "react";
import { useActionState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { btn } from "@/components/kit";
import { signUpAction, type AuthFormState } from "@/app/actions/auth";
import { directCredentialsSignIn } from "@/lib/client-auth";

const FIELD =
  "w-full rounded-[10px] border border-edge bg-well px-3.5 py-2.5 text-[14px] text-t1 outline-none transition-colors placeholder:text-t3 focus:border-brand/50";

export function SignupForm() {
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(signUpAction, {});
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const submitted = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  /* the action created the account when it returns without an error —
     finish the session from the browser (server-action signIn hairpins and
     breaks on Catalyst AppSail; the direct form-post does not) */
  useEffect(() => {
    if (!submitted.current || state.error) return;
    submitted.current = false;
    const data = new FormData(formRef.current ?? undefined);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    setSigningIn(true);
    void directCredentialsSignIn(email, password).then((result) => {
      if (!result.ok) {
        setSignInError(result.error ?? "Account created, but sign-in failed — try signing in.");
        setSigningIn(false);
      }
      // on success we navigate wholesale — the loading state is left running
    });
  }, [state]);

  return (
    <form
      ref={formRef}
      action={(formData) => {
        submitted.current = true;
        formAction(formData);
      }}
      className="space-y-4"
    >
      <div>
        <label htmlFor="name" className="eyebrow eyebrow-strong mb-2 block">
          Name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          maxLength={80}
          autoComplete="name"
          placeholder="Ada Lovelace"
          className={FIELD}
        />
      </div>

      <div>
        <label htmlFor="email" className="eyebrow eyebrow-strong mb-2 block">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          className={FIELD}
        />
      </div>

      <div>
        <label htmlFor="password" className="eyebrow eyebrow-strong mb-2 block">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          placeholder="at least 8 characters"
          className={FIELD}
        />
      </div>

      {state.error || signInError ? (
        <p role="alert" className="rounded-[10px] border border-bad/30 bg-bad/10 px-3.5 py-2.5 text-[12.5px] text-bad">
          {state.error ?? signInError}
        </p>
      ) : null}

      <button type="submit" disabled={pending || signingIn} className={btn("primary", "lg", "w-full font-semibold")}>
        {pending || signingIn ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {signingIn ? "Signing in" : "Creating account"}
          </>
        ) : (
          <>
            Create account
            <ArrowRight className="h-4 w-4" />
          </>
        )}
      </button>
    </form>
  );
}
