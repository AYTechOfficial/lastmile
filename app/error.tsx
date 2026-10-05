"use client";

import { AlertOctagon } from "lucide-react";
import { btn } from "@/components/kit";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-app px-6 text-t1">
      <div className="panel w-full max-w-[520px] rounded-[16px] p-6">
        <span className="flex h-10 w-10 items-center justify-center rounded-[12px] border border-bad/30 bg-bad/10">
          <AlertOctagon className="h-5 w-5 text-bad" />
        </span>
        <h1 className="display mt-4 text-[19px] font-semibold tracking-[-0.02em]">
          Something broke on this screen
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-t2">
          The error is below. Retrying re-renders the view; if it keeps failing, the run itself is
          unaffected — its state lives in the database, not in this component.
        </p>
        <pre className="well thin-scroll mt-4 max-h-[160px] overflow-auto rounded-[10px] p-3 font-mono text-[11px] leading-relaxed text-t2">
          {error.message || "Unknown error"}
          {error.digest ? "\n\ndigest: " + error.digest : ""}
        </pre>
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={reset} className={btn("primary", "md")}>
            Try again
          </button>
          <a href="/dashboard" className={btn("outline", "md")}>
            Back to dashboard
          </a>
        </div>
      </div>
    </main>
  );
}
