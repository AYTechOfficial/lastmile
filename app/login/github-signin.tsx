"use client";

import { useState } from "react";
import { GithubIcon } from "@/components/github-icon";
import { btn } from "@/components/kit";
import { directOAuthSignIn } from "@/lib/client-auth";

export function GithubSigninButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setPending(true);
    setError(null);
    const result = await directOAuthSignIn("github");
    if (!result.ok) {
      setError(result.error ?? "Could not start the GitHub sign-in — try again.");
      setPending(false);
    }
    // on success the browser navigates to GitHub's authorize page
  }

  return (
    <div className="space-y-2">
      <button type="button" onClick={onClick} disabled={pending} className={btn("outline", "lg", "w-full")}>
        <GithubIcon className="h-4 w-4" />
        {pending ? "Redirecting…" : "Continue with GitHub"}
      </button>
      {error ? (
        <p role="alert" className="rounded-[10px] border border-bad/30 bg-bad/10 px-3.5 py-2.5 text-[12.5px] text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}
