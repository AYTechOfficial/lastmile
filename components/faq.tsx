"use client";

import { AnimatePresence, motion } from "motion/react";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Reveal, SectionHead, cn } from "@/components/ui";

const QA = [
  {
    q: "Is this just another prompt-to-app builder?",
    a: "No. Builders stop at code — that’s the whole problem. LastMile starts with live research, gets your approval on a real spec, and doesn’t call itself done until the deployed app has passed its core flows on the live URL.",
  },
  {
    q: "What does “verified” actually mean?",
    a: "Every core flow in your spec becomes a Playwright test run against the deployed URL — real browser, real clicks, real data. Passing runs ship with screenshots, logs, and a trace. A failing flow triggers a fix-and-retest loop, inside an attempt budget.",
  },
  {
    q: "Is the code mine? Is there lock-in?",
    a: "The code is yours, end to end — pushed to your connected GitHub from a curated Next.js + Tailwind production scaffold. You can eject the moment the run finishes and hire any developer to continue. No proprietary runtime, no hostage data.",
  },
  {
    q: "Who is it for?",
    a: "Non-technical founders, students, indie hackers, entrepreneurs, and small agencies who want a first draft that actually runs — the same crowd driving the prompt-to-app boom, minus the days of manual cleanup afterward.",
  },
  {
    q: "When can I use it?",
    a: "The pipeline is in private build. Join the waitlist and you’ll get one email when links are being handed out — a link that passed, naturally.",
  },
];

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" className="relative bg-deep/40 py-28 md:py-36">
      <div className="mx-auto max-w-4xl px-6">
        <SectionHead
          kicker="FAQ"
          title={
            <>
              Asked, <span className="serif-accent text-iris">answered.</span>
            </>
          }
        />

        <div className="mt-14">
          {QA.map((item, i) => {
            const isOpen = open === i;
            return (
              <Reveal key={item.q} delay={i * 0.04}>
                <div className="border-t border-line last:border-b">
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : i)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center justify-between gap-6 py-6 text-left"
                  >
                    <span
                      className={cn(
                        "text-lg font-medium transition-colors md:text-xl",
                        isOpen ? "text-iris" : "text-cream",
                      )}
                    >
                      {item.q}
                    </span>
                    <motion.span
                      animate={{ rotate: isOpen ? 45 : 0 }}
                      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                      className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors",
                        isOpen ? "border-iris/40 text-iris" : "border-line text-dim",
                      )}
                    >
                      <Plus className="h-4 w-4" />
                    </motion.span>
                  </button>
                  <AnimatePresence initial={false}>
                    {isOpen ? (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                      >
                        <p className="max-w-2xl pb-7 leading-relaxed text-dim">{item.a}</p>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
