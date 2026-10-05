"use client";

import { useActionState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { btn } from "@/components/kit";
import { signInAction, type AuthFormState } from "@/app/actions/auth";

const FIELD =
  "w-full rounded-[10px] border border-edge bg-well px-3.5 py-2.5 text-[14px] text-t1 outline-none transition-colors placeholder:text-t3 focus:border-brand/50";

export function LoginForm() {
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(signInAction, {});

  return (
    <form action={formAction} className="space-y-4">
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
          autoComplete="current-password"
          placeholder="••••••••"
          className={FIELD}
        />
      </div>

      {state.error ? (
        <p role="alert" className="rounded-[10px] border border-bad/30 bg-bad/10 px-3.5 py-2.5 text-[12.5px] text-bad">
          {state.error}
        </p>
      ) : null}

      <button type="submit" disabled={pending} className={btn("primary", "lg", "w-full font-semibold")}>
        {pending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Signing in
          </>
        ) : (
          <>
            Sign in
            <ArrowRight className="h-4 w-4" />
          </>
        )}
      </button>
    </form>
  );
}
