"use client";

import { motion, useScroll } from "motion/react";
import { Check, Loader2, X } from "lucide-react";
import { useRef, useState } from "react";
import { Reveal, SectionHead, cn, useScrollStep } from "@/components/ui";

/* The Proof Pack replays itself as you scroll: flows run, one fails, the
   pipeline fixes it, everything passes. Scrubbed by scroll — not a timer. */

type Row = {
  name: string;
  meta: string;
  time: string;
  /** scroll step at which this flow passes */
  passAt?: number;
  failAt?: number;
  fixedAt?: number;
};

const ROWS: Row[] = [
  { name: "Signup → login → dashboard", meta: "4 assertions · chromium", time: "1.9s", passAt: 1 },
  { name: "Create project · persists on reload", meta: "6 assertions · chromium", time: "2.4s", passAt: 2 },
  { name: "Invite teammate by email", meta: "5 assertions · chromium", time: "2m 14s", failAt: 3, fixedAt: 4 },
  { name: "Payment stub renders in checkout", meta: "3 assertions · chromium", time: "0.8s", passAt: 4 },
];

const META = [
  { value: "0", label: "console errors" },
  { value: "0", label: "network 4xx / 5xx" },
  { value: "12", label: "screenshots" },
  { value: "1", label: "trace attached" },
  { value: "✓", label: "visual check (VLM)" },
];

const STEPS_TOTAL = 4;

function StatusPill({ row, step }: { row: Row; step: number }) {
  if (row.fixedAt !== undefined) {
    if (step >= row.fixedAt)
      return (
        <span className="flex items-center gap-1 rounded-full border border-amber/40 bg-amber/10 px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider text-amber">
          <X className="h-2.5 w-2.5" /> → <Check className="h-2.5 w-2.5" /> fixed
        </span>
      );
    if (row.failAt !== undefined && step >= row.failAt)
      return (
        <span className="flex items-center gap-1 rounded-full border border-fail/40 bg-fail/10 px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider text-fail">
          <X className="h-2.5 w-2.5" /> fail
        </span>
      );
  } else if (row.passAt !== undefined && step >= row.passAt) {
    return (
      <span className="rounded-full border border-iris/40 bg-iris/10 px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider text-iris">
        pass
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider text-dim/60">
      <Loader2 className="h-2.5 w-2.5 animate-spin" /> queued
    </span>
  );
}

export function ProofPack() {
  const ref = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.85", "end 0.5"],
  });
  useScrollStep(scrollYProgress, STEPS_TOTAL + 1, setStep);

  const progress = step / STEPS_TOTAL;

  return (
    <section id="proof" className="relative overflow-hidden py-28 md:py-40">
      <div
        aria-hidden
        className="glow-iris pointer-events-none absolute -right-52 top-24 -z-10 h-[520px] w-[520px]"
      />
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid items-center gap-14 lg:grid-cols-[1fr_1.2fr]">
          <div ref={ref}>
            <SectionHead
              kicker="Stage 04 · output"
              title={
                <>
                  Every run ships with <span className="serif-accent grad-text">receipts.</span>
                </>
              }
              sub="Not a promise — a report. Each core flow from your spec becomes a Playwright test against the deployed URL. What was tested, what failed, what got fixed, what passed — with screenshots, console and network logs, and a trace attached."
            />
            <Reveal delay={0.2}>
              <p className="mt-8 flex items-center gap-2.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-iris/80">
                <motion.span
                  animate={{ y: [0, 4, 0] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                >
                  ↓
                </motion.span>
                keep scrolling — replay the verification of run #0042
              </p>
            </Reveal>
          </div>

          {/* the scrubbed report */}
          <div className="glass overflow-hidden rounded-3xl shadow-[0_40px_120px_-40px_rgba(0,0,0,0.9)]">
            <div className="flex items-center gap-2 border-b border-line px-5 py-3.5">
              <span className="h-2.5 w-2.5 rounded-full bg-fail/60" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber/60" />
              <span className="h-2.5 w-2.5 rounded-full bg-iris/60" />
              <p className="ml-3 truncate font-mono text-[10.5px] tracking-wider text-dim">
                verification-report — run #0042 — photographer-crm.vercel.app
              </p>
              <span
                className={cn(
                  "ml-auto shrink-0 font-mono text-[9px] uppercase tracking-[0.18em]",
                  step >= STEPS_TOTAL ? "text-iris" : "text-amber",
                )}
              >
                {step >= STEPS_TOTAL ? "✓ all passing" : `verifying ${step}/${STEPS_TOTAL}`}
              </span>
            </div>

            {/* scrub progress */}
            <div className="h-[3px] w-full bg-line/50">
              <div
                className="h-full bg-gradient-to-r from-iris to-cyan transition-[width] duration-500 ease-out"
                style={{ width: `${progress * 100}%` }}
              />
            </div>

            <div className="space-y-2.5 p-5 md:p-6">
              {ROWS.map((row, i) => {
                const done =
                  (row.fixedAt !== undefined && step >= row.fixedAt) ||
                  (row.fixedAt === undefined && row.passAt !== undefined && step >= row.passAt);
                return (
                  <div
                    key={row.name}
                    className={cn(
                      "flex items-center justify-between gap-4 rounded-xl border px-4 py-3 transition-all duration-500",
                      done
                        ? "border-line bg-ink/60"
                        : "border-line/50 bg-ink/30 opacity-60",
                    )}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-cream">
                        <span className="mr-2 font-mono text-[10px] text-dim/60">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        {row.name}
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] tracking-wider text-dim/70">
                        {row.meta}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5">
                      <span className="font-mono text-[10px] text-dim/70">{row.time}</span>
                      <StatusPill row={row} step={step} />
                    </div>
                  </div>
                );
              })}

              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-5">
                {META.map((m, i) => (
                  <div
                    key={m.label}
                    className={cn(
                      "bg-panel px-2 py-3.5 text-center transition-opacity duration-700",
                      step >= STEPS_TOTAL ? "opacity-100" : "opacity-40",
                      i === 0 && "col-span-2 md:col-span-1",
                    )}
                  >
                    <p className="text-lg font-semibold text-cream">{m.value}</p>
                    <p className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-dim/70">
                      {m.label}
                    </p>
                  </div>
                ))}
              </div>

              {/* screenshots light up as flows resolve */}
              <div className="grid grid-cols-4 gap-2 pt-1">
                {[0, 1, 2, 3].map((n) => (
                  <div
                    key={n}
                    className={cn(
                      "relative aspect-[4/3] overflow-hidden rounded-lg border transition-all duration-700",
                      step >= n + 1
                        ? "border-iris/30 bg-gradient-to-br from-raise to-panel"
                        : "border-line/60 bg-deep",
                    )}
                  >
                    <div className="absolute inset-x-3 top-2.5 flex gap-1">
                      <span className="h-1 w-1 rounded-full bg-fail/50" />
                      <span className="h-1 w-1 rounded-full bg-amber/50" />
                      <span className="h-1 w-1 rounded-full bg-iris/50" />
                    </div>
                    <div
                      className={cn(
                        "absolute inset-x-3 top-7 space-y-1.5 transition-opacity duration-700",
                        step >= n + 1 ? "opacity-100" : "opacity-30",
                      )}
                    >
                      <div className="h-1.5 w-3/4 rounded bg-cream/15" />
                      <div className="h-1.5 w-1/2 rounded bg-cream/10" />
                      <div className="h-1.5 w-2/3 rounded bg-iris/25" />
                    </div>
                    <p className="absolute bottom-2 left-3 font-mono text-[9px] tracking-wider text-dim/70">
                      flow-{n + 1}.png
                    </p>
                    {step >= n + 1 ? (
                      <motion.span
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-iris text-ink"
                      >
                        <Check className="h-2.5 w-2.5" strokeWidth={3} />
                      </motion.span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
