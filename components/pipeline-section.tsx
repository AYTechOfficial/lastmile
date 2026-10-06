"use client";

import { AnimatePresence, motion, useMotionValueEvent, useScroll, useSpring } from "motion/react";
import { useRef, useState } from "react";
import { Chip, Reveal, SectionHead, cn } from "@/components/ui";

const STAGES = [
  {
    num: "01",
    title: "Research",
    lede: "Real products, real stacks.",
    body: "The Research Agent reads your sentence and searches live for comparable products — their current features, pricing, tech stacks — plus the tools it actually takes to ship one to production. The build starts from evidence, not a guess.",
    chips: ["live web search", "competitive matrix", "production checklist"],
  },
  {
    num: "02",
    title: "Spec",
    lede: "The PRD, written properly.",
    body: "The Spec Agent turns that research into a senior-engineer-quality build prompt: user stories, data model, screens, API surface — and acceptance criteria for every core flow, which later become the verification tests.",
    chips: ["user stories", "data model", "acceptance criteria"],
  },
  {
    num: "◆",
    title: "You approve",
    lede: "A quick look before anything is built.",
    body: "The spec lands in your dashboard. Edit anything, approve when it’s right — so no build time is ever wasted on a misread one-liner. The only human step in the whole pipeline, and it takes two minutes.",
    chips: ["human checkpoint", "edit anything", "2-minute review"],
    amber: true,
  },
  {
    num: "03",
    title: "Build",
    lede: "The codebase, end to end.",
    body: "The Core Build Agent writes the full app on a curated Next.js + Tailwind production scaffold, then proves it locally — install, typecheck, build, smoke test — before pushing everything to your connected GitHub. It’s your code. No lock-in.",
    chips: ["your github", "internal smoke tests", "no lock-in"],
  },
  {
    num: "04",
    title: "Deploy & Verify",
    lede: "Tests the live app. Then fixes it.",
    body: "Deploys to your connected Vercel, generates Playwright tests from the spec’s acceptance criteria, and runs them against the live URL. On failure it loops: diagnose, fix, redeploy, re-test — inside an attempt budget.",
    chips: ["playwright vs live url", "loops until it passes", "attempt budget"],
    loop: true,
  },
  {
    num: "✓",
    title: "Output",
    lede: "A working link, already checked.",
    body: "Handed over with the Proof Pack: what was tested, what failed, what got fixed, what passed. You click a link that has already survived its own exam.",
    chips: ["verified link", "proof pack attached"],
    iris: true,
  },
];

export function PipelineSection() {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.72", "end 0.65"],
  });
  const scaleY = useSpring(scrollYProgress, { stiffness: 90, damping: 22, mass: 0.4 });

  useMotionValueEvent(scrollYProgress, "change", (v) => {
    setActive(Math.min(STAGES.length - 1, Math.max(0, Math.floor(v * STAGES.length))));
  });

  return (
    <section id="pipeline" className="relative bg-deep/40 py-28 md:py-40">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHead
          kicker="The pipeline"
          title={
            <>
              Four agents. One checkpoint.{" "}
              <span className="serif-accent text-iris">Zero broken links.</span>
            </>
          }
          sub="Run one sentence in. Every stage hands its output to the next — and nothing reaches you until the last stage says the live product actually works."
        />

        <div ref={ref} className="mt-20 grid gap-10 md:grid-cols-[220px_1fr] md:gap-16">
          {/* sticky progress rail + giant stage numeral */}
          <div className="sticky top-24 hidden h-fit md:block">
            <div className="relative mb-8 h-[104px] overflow-hidden">
              <AnimatePresence mode="popLayout">
                <motion.span
                  key={active}
                  initial={{ opacity: 0, y: 36 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -36 }}
                  transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                  className={cn(
                    "absolute left-0 font-sans text-[96px] font-semibold leading-none tracking-tighter",
                    STAGES[active].amber ? "text-amber/[0.13]" : "text-iris/[0.13]",
                  )}
                >
                  {STAGES[active].num}
                </motion.span>
              </AnimatePresence>
            </div>
            <div className="relative pl-7">
              <div aria-hidden className="absolute left-[7px] top-2 bottom-2 w-px bg-line" />
              <motion.div
                aria-hidden
                style={{ scaleY }}
                className="absolute left-[7px] top-2 bottom-2 w-px origin-top bg-gradient-to-b from-iris to-irisdeep"
              />
              <ul className="space-y-5">
                {STAGES.map((s, i) => (
                  <li
                    key={s.num}
                    className={cn(
                      "font-mono text-[11px] uppercase tracking-[0.18em] transition-colors duration-400",
                      active === i
                        ? s.amber
                          ? "text-amber"
                          : "text-iris"
                        : "text-dim/45",
                    )}
                  >
                    {s.num} {s.title}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* stage cards */}
          <div className="space-y-6 md:space-y-0">
            {STAGES.map((s) => (
              <div
                key={s.num}
                className="md:flex md:min-h-[54vh] md:flex-col md:justify-center"
              >
                <Reveal delay={0.04}>
                  <div
                    className={cn(
                      "relative rounded-3xl border p-8 transition-colors duration-500 md:p-10",
                      s.amber
                        ? "border-amber/30 bg-amber/[0.045]"
                        : s.iris
                          ? "border-iris/35 bg-iris/[0.05] shadow-[0_0_80px_-20px_rgba(133,131,255,0.3)]"
                          : "glass",
                    )}
                  >
                    <div className="flex items-baseline gap-4">
                      <span
                        className={cn(
                          "font-mono text-sm",
                          s.amber ? "text-amber" : s.iris ? "text-iris" : "text-iris/80",
                        )}
                      >
                        {s.num}
                      </span>
                      <h3 className="text-2xl font-semibold tracking-tight md:text-3xl">
                        {s.title}
                      </h3>
                    </div>
                    <p
                      className={cn(
                        "mt-3 text-lg md:text-xl",
                        s.amber ? "text-amber" : "serif-accent text-iris",
                      )}
                    >
                      {s.lede}
                    </p>
                    <p className="mt-4 max-w-xl leading-relaxed text-dim">{s.body}</p>
                    {s.loop ? (
                      <p className="mt-5 font-mono text-[11.5px] uppercase tracking-[0.16em] text-amber">
                        ↶ fails → fixes → re-tests — until the core flows pass
                      </p>
                    ) : null}
                    <div className="mt-6 flex flex-wrap gap-2">
                      {s.chips.map((c) => (
                        <Chip key={c} amber={s.amber}>
                          {c}
                        </Chip>
                      ))}
                    </div>
                  </div>
                </Reveal>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
