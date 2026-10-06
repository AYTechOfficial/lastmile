"use client";

import { motion } from "motion/react";
import { SectionHead, SpotlightCard } from "@/components/ui";

function FlowChips() {
  return (
    <div className="mt-8 flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em]">
      {["prompt", "code", "??? ", "you"].map((step, i) => (
        <span key={step} className="flex items-center gap-2">
          {i > 0 ? <span className="text-dim/50">→</span> : null}
          {step.trim() === "???" ? (
            <motion.span
              animate={{ opacity: [1, 0.45, 1] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
              className="rounded-lg border border-fail/40 bg-fail/10 px-3 py-1.5 text-fail"
            >
              ???
            </motion.span>
          ) : (
            <span className="rounded-lg border border-line bg-ink px-3 py-1.5 text-dim">
              {step}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

const CARDS = [
  {
    kicker: "one-shot builders · bolt, lovable, replit agent",
    title: "Everything stops at “code generated.”",
    body: "Prompt straight to code, with no research shaping the spec — so v1 regularly ships missing what a comparable production app would already have. And raw output still needs real cleanup before it’s genuinely production-ready.",
    visual: "flows",
  },
  {
    kicker: "your evenings",
    title: "Silent deploy breaks.",
    body: "Picking a stack. Wiring auth and a database. Fighting a deployment that fails for reasons nobody warned you about — alone, at 1am, on a stack you didn’t choose.",
  },
  {
    kicker: "the last mile",
    title: "Nobody checks the live app.",
    body: "Freelancers, no-code, one-shot builders, even autonomous agents — none of them, at any price, re-check the live URL after deploying and fix it themselves.",
  },
];

export function Problem() {
  return (
    <section id="why" className="relative py-28 md:py-40">
      <div className="mx-auto max-w-5xl px-6">
        <SectionHead
          kicker="The gap"
          title={
            <>
              Good ideas don’t die at ideation.{" "}
              <span className="text-dim">They die at</span>{" "}
              <span className="serif-accent grad-text">execution.</span>
            </>
          }
          sub="A whole generation of builders can finally ship. What they get back, almost every time, is a first version — not a product. Here’s where the time actually goes, and where it leaks."
        />

        {/* pinned stack — each card slides over the last as you scroll */}
        <div className="mt-16">
          {CARDS.map((c, i) => (
            <div
              key={c.kicker}
              className="sticky pb-6"
              style={{ top: `${96 + i * 20}px`, zIndex: i + 1 }}
            >
              <SpotlightCard className="rounded-3xl border border-line bg-panel shadow-[0_36px_90px_-32px_rgba(0,0,0,0.9)]">
                <div className="p-8 md:p-10">
                  <p className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-dim">
                    {c.kicker}
                  </p>
                  <h3 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">
                    {c.title}
                  </h3>
                  <p className="mt-4 max-w-xl leading-relaxed text-dim">{c.body}</p>
                  {c.visual === "flows" ? <FlowChips /> : null}
                </div>
              </SpotlightCard>
            </div>
          ))}

          {/* the turn */}
          <div
            className="sticky pb-6"
            style={{ top: `${96 + CARDS.length * 20}px`, zIndex: CARDS.length + 1 }}
          >
            <div className="rounded-3xl border border-iris/35 bg-gradient-to-b from-iris/[0.09] to-panel p-8 shadow-[0_36px_90px_-32px_rgba(0,0,0,0.9),0_0_70px_-24px_rgba(133,131,255,0.35)] md:p-10">
              <p className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-iris">
                the turn
              </p>
              <p className="mt-4 text-xl font-medium leading-relaxed text-cream md:text-2xl">
                LastMile exists for exactly that sentence.{" "}
                <span className="text-dim">
                  Stage 04 — deploy, test the live URL against the real core flows, fix, re-test —
                  is the step no route on the market performs.
                </span>{" "}
                <span className="serif-accent grad-text">It’s the whole product.</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
