"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Reveal, SectionHead } from "@/components/ui";

export function Waitlist() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError(true);
      return;
    }
    setError(false);
    try {
      localStorage.setItem("lastmile-waitlist", email.trim());
    } catch {
      /* storage unavailable — the success state still stands */
    }
    setDone(true);
  }

  return (
    <section id="waitlist" className="relative overflow-hidden py-32 md:py-44">
      <div
        aria-hidden
        className="glow-iris pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[560px] w-[860px] -translate-x-1/2 -translate-y-1/2"
      />
      <div className="mx-auto max-w-3xl px-6 text-center">
        <SectionHead
          kicker="Waitlist"
          title={
            <>
              Be first in line for a link that{" "}
              <span className="serif-accent text-iris">actually works.</span>
            </>
          }
          sub="The pipeline is being finished in the open. One email when it opens — the only link we’ll ever send you untested is this page."
          align="center"
          className="mx-auto items-center"
        />

        <Reveal delay={0.16}>
          <div className="mx-auto mt-12 max-w-xl">
            <AnimatePresence mode="wait">
              {done ? (
                <motion.div
                  key="done"
                  initial={{ opacity: 0, scale: 0.94, y: 8 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                  className="glass flex items-center justify-center gap-3 rounded-full px-8 py-4"
                >
                  <CheckCircle2 className="h-5 w-5 text-iris" />
                  <p className="text-[15px] font-medium text-cream">
                    You’re in. One email when the pipeline opens — that’s it.
                  </p>
                </motion.div>
              ) : (
                <motion.form
                  key="form"
                  exit={{ opacity: 0, scale: 0.97 }}
                  onSubmit={submit}
                  className="glass flex flex-col gap-3 rounded-3xl p-3 sm:flex-row sm:rounded-full"
                >
                  <label htmlFor="waitlist-email" className="sr-only">
                    Email address
                  </label>
                  <input
                    id="waitlist-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setError(false);
                    }}
                    placeholder="you@yourdomain.com"
                    className={`min-w-0 flex-1 rounded-full bg-transparent px-5 py-3.5 text-[15px] text-cream placeholder:text-dim/50 focus:outline-none ${
                      error ? "text-fail placeholder:text-fail/60" : ""
                    }`}
                  />
                  <button
                    type="submit"
                    className="group inline-flex items-center justify-center gap-2 rounded-full bg-cream px-7 py-3.5 text-[15px] font-semibold text-ink transition-colors hover:bg-white"
                  >
                    Join the waitlist
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </button>
                </motion.form>
              )}
            </AnimatePresence>
            <p className="mt-4 font-mono text-[10.5px] uppercase tracking-[0.16em] text-dim/60">
              {error ? "that email doesn’t look right — try again" : "no spam. one email, when links are ready."}
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
