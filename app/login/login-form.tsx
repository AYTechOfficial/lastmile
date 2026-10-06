"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
import { btn } from "@/components/kit";
import { directCredentialsSignIn } from "@/lib/client-auth";

const FIELD =
  "w-full rounded-[10px] border border-edge bg-well px-3.5 py-2.5 text-[14px] text-t1 outline-none transition-colors placeholder:text-t3 focus:border-brand/50";

export function LoginForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    const result = await directCredentialsSignIn(
      String(data.get("email") ?? ""),
      String(data.get("password") ?? ""),
    );
    if (!result.ok) {
      setError(result.error ?? "Invalid email or password.");
      setPending(false);
      return;
    }

    /* The session cookie is set, so a client-side push plus a refresh is
       enough — the loading state is intentionally left running. */
    router.push(result.redirectTo ?? "/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
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

      {error ? (
        <p role="alert" className="rounded-[10px] border border-bad/30 bg-bad/10 px-3.5 py-2.5 text-[12.5px] text-bad">
          {error}
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
