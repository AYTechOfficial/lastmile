"use client";

import { useActionState } from "react";
import { Loader2, MessageSquareCode } from "lucide-react";
import { continueRunAction, type ContinueRunState } from "@/app/actions/runs";
import { btn } from "@/components/kit";

/* The continue box: a run that ended is not a dead end. The human types what
   they want next — a feature ("add auth and signup"), a research ask ("find
   me cheaper competitors"), a design overhaul, a re-check — and a model
   routes the request to whichever agent it is really for. The pipeline's own
   machinery takes it from there: checkpoint gate, quality loop, redeploy. */

const initial: ContinueRunState = {};

export function ContinueBox({ runId }: { runId: string }) {
  const [state, action, pending] = useActionState(continueRunAction, initial);

  return (
    <form action={action} className="rounded-[16px] border border-brand/25 bg-surface">
      <div className="flex items-start gap-3.5 px-5 pt-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-brand/40 bg-brand/10">
          <MessageSquareCode className="h-5 w-5 text-brand" />
        </span>
        <div className="min-w-0">
          <p className="display text-[15.5px] font-semibold text-t1">Keep building.</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-t3">
            Ask for anything — a new feature (&ldquo;add auth and signup&rdquo;), more research
            (&ldquo;find cheaper competitors&rdquo;), a design overhaul, or a re-check. The request is
            routed to the right agent, and the pipeline runs it end to end: checkpoint, build, verify, redeploy.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2.5 px-5 py-4 sm:flex-row">
        <input type="hidden" name="runId" value={runId} />
        <textarea
          name="request"
          required
          minLength={5}
          maxLength={600}
          rows={2}
          placeholder="e.g. add an auth and signup system with email verification…"
          className="min-h-[52px] flex-1 resize-y rounded-[10px] border border-edge bg-well px-3.5 py-2.5 text-[13.5px] text-t1 outline-none transition-colors placeholder:text-t3 focus:border-brand/60"
        />
        <button type="submit" disabled={pending} className={btn("brand", "md", "font-semibold shrink-0 sm:self-end")}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {pending ? "Routing…" : "Continue building"}
        </button>
      </div>
      {state.error ? (
        <p className="border-t border-bad/25 bg-bad/10 px-5 py-2.5 text-[12px] text-bad">{state.error}</p>
      ) : null}
      {state.ok && state.notice ? (
        <p className="border-t border-pass/25 bg-pass/10 px-5 py-2.5 text-[12px] text-pass">{state.notice}</p>
      ) : null}
    </form>
  );
}
