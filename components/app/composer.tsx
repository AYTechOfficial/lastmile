"use client";

import { useActionState, useRef, useState } from "react";
import { ArrowUp, CornerDownLeft, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { Kbd, btn } from "@/components/kit";
import { createRunAction, type CreateRunState } from "@/app/actions/runs";

const EXAMPLES = [
  "A CRM for freelance photographers",
  "A habit tracker with streaks and reminders",
  "An invoice generator for freelancers",
  "A waitlist page with referral tracking",
];

const STEPS = ["research", "spec", "you approve", "build", "deploy", "verify"];

/* The composer is the product's front door. It does three jobs: take one
   sentence, teach what happens to it, and get out of the way. */
export function Composer() {
  const [state, formAction, pending] = useActionState<CreateRunState, FormData>(createRunAction, {});
  const [sentence, setSentence] = useState("");
  const [focused, setFocused] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const len = sentence.trim().length;
  const ready = len >= 10 && len <= 200;

  return (
    <section id="compose" className={cn("scroll-mt-24 rounded-[16px] p-[1px] transition-colors duration-300", focused ? "bg-gradient-to-r from-brand/60 via-info/35 to-brand/60" : "bg-edge")}>
      <div className="rounded-[15px] bg-surface">
        <form ref={formRef} action={formAction}>
          <div className="flex items-start gap-3 px-4 pt-4 md:px-5">
            <span
              className={cn(
                "mt-[3px] flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border transition-colors",
                focused ? "border-brand/40 bg-brand/15 text-brand" : "border-edge bg-surface2 text-t3",
              )}
            >
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <label htmlFor="sentence" className="eyebrow eyebrow-strong">
                What should the pipeline build?
              </label>
              <textarea
                id="sentence"
                name="sentence"
                value={sentence}
                onChange={(e) => setSentence(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    formRef.current?.requestSubmit();
                  }
                }}
                rows={2}
                maxLength={200}
                required
                placeholder="a CRM for freelance photographers"
                className="mt-2 w-full resize-none bg-transparent pr-2 text-[19px] font-medium leading-snug tracking-[-0.015em] text-t1 outline-none placeholder:text-t3 md:text-[21px]"
              />
            </div>
          </div>

          {state.error ? (
            <p role="alert" className="mx-4 mb-2 rounded-[10px] border border-bad/30 bg-bad/10 px-3 py-2 text-[12.5px] text-bad md:mx-5">
              {state.error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-4 py-3 md:px-5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {EXAMPLES.slice(0, 3).map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setSentence(ex)}
                  className="rounded-full border border-edge bg-surface2 px-2.5 py-1 text-[11.5px] text-t3 transition-colors hover:border-brand/30 hover:bg-brand/10 hover:text-t1"
                >
                  {ex.replace(/^A /, "")}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <span className="tnum hidden font-mono text-[10.5px] text-t3 sm:inline">{len}/200</span>
              <span className="hidden items-center gap-1 text-[11px] text-t3 md:flex">
                <Kbd>
                  <CornerDownLeft className="h-2.5 w-2.5" />
                </Kbd>
                to start
              </span>
              <button type="submit" disabled={pending || !ready} className={btn("brand", "md", "pr-3")}>
                {pending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Starting
                  </>
                ) : (
                  <>
                    Run the pipeline
                    <ArrowUp className="h-3.5 w-3.5" />
                  </>
                )}
              </button>
            </div>
          </div>
        </form>

        {/* what happens to that sentence — the pipeline, before you commit */}
        <div className="flex items-center gap-0 overflow-x-auto border-t border-edge px-4 py-2.5 md:px-5">
          {STEPS.map((s, i) => (
            <div key={s} className="flex shrink-0 items-center">
              {i > 0 ? <span className="mx-1.5 h-px w-3 bg-edge2" /> : null}
              <span
                className={cn(
                  "font-mono text-[9.5px] uppercase tracking-[0.14em]",
                  s === "you approve" ? "text-warn" : s === "verify" ? "text-pass" : "text-t3",
                )}
              >
                {String(i + 1).padStart(2, "0")} {s}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
