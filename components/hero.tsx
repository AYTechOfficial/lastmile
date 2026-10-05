"use client";

import { motion, useScroll, useTransform } from "motion/react";
import { ArrowDown, ArrowRight } from "lucide-react";
import { useRef } from "react";
import { Chip, Magnetic, Reveal } from "@/components/ui";
import { DashboardMock } from "@/components/dashboard-mock";
import { FogCanvas } from "@/components/fog-canvas";
import { signupOpen } from "@/lib/signup-mode";

/* NOTE: this hero deliberately avoids negative z-index layers — some rendering
   environments (throttled webviews, software compositors) drop them entirely.
   Back layers sit at z-0 in DOM order; content is lifted with positive z. */

export function Hero() {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end start"],
  });

  // the window recedes into the story as you scroll — flat → tilted → small
  const rotateX = useTransform(scrollYProgress, [0, 1], [0, 14]);
  const scale = useTransform(scrollYProgress, [0, 1], [1, 0.93]);
  const y = useTransform(scrollYProgress, [0, 1], [0, 90]);
  const glowOpacity = useTransform(scrollYProgress, [0, 1], [1, 0.2]);
  // the smoke lags behind the page and thins out as you leave the hero
  const fogY = useTransform(scrollYProgress, [0, 1], [0, 100]);
  const fogOpacity = useTransform(scrollYProgress, [0, 0.7], [1, 0]);

  return (
    <section ref={ref} className="relative overflow-hidden pb-16 pt-32 md:pt-36">
      {/* back layers — DOM order paints them under the content, no negative z */}
      <div aria-hidden className="absolute inset-0 z-0 overflow-hidden">
        {/* the smoke lives in a container oversized 15% past the section on
            top/bottom, so the 100px parallax drift can never reveal an edge */}
        <motion.div
          style={{ y: fogY, opacity: fogOpacity }}
          className="absolute inset-x-0 -top-[15%] -bottom-[15%]"
        >
          <FogCanvas />
        </motion.div>
        <motion.div
          style={{ opacity: glowOpacity }}
          className="glow-iris absolute left-1/2 top-40 h-[560px] w-[980px] -translate-x-1/2"
        />
        <div className="grid-bg absolute inset-x-0 top-0 h-[860px]" />
        {/* soft scrim keeping the headline crisp */}
        <div className="absolute inset-x-0 top-0 h-[640px] bg-[radial-gradient(ellipse_60%_50%_at_50%_30%,rgba(7,8,11,0.32),transparent 78%)]" />
      </div>

      <div className="relative z-10 mx-auto max-w-6xl px-6">
        <Reveal>
          <p className="mx-auto flex w-fit items-center gap-2.5 rounded-full border border-line bg-panel/60 px-4 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.22em] text-dim">
            <span aria-hidden className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-iris" />
            sentence in → verified link out
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <h1 className="mx-auto mt-7 max-w-4xl text-center text-[40px] font-semibold leading-[1.04] tracking-[-0.03em] sm:text-6xl md:mt-8 md:text-[84px]">
            One sentence in.
            <br />A{" "}
            <span className="serif-accent grad-text pr-2">verified</span> product out.
          </h1>
        </Reveal>

        <Reveal delay={0.2}>
          <p className="mx-auto mt-7 max-w-2xl text-center text-base leading-relaxed text-dim md:text-lg">
            LastMile is a chained multi-agent pipeline that researches your market, writes the
            spec, builds the codebase, ships it to a live URL — then tests the real app against
            its core flows and fixes what breaks. You only ever see a link that passed.
          </p>
        </Reveal>

        <Reveal delay={0.3}>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            {signupOpen() ? (
              <>
                <Magnetic>
                  <motion.a
                    href="/signup"
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    className="group inline-flex items-center gap-2 rounded-full bg-cream px-7 py-3.5 text-[15px] font-semibold text-ink shadow-[0_8px_30px_-8px_rgba(245,245,247,0.35)] transition-colors hover:bg-white"
                  >
                    Start building
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </motion.a>
                </Magnetic>
                <Magnetic>
                  <motion.a
                    href="/login"
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    className="group inline-flex items-center gap-2 rounded-full border border-cream/25 bg-ink/40 px-7 py-3.5 text-[15px] font-medium text-cream backdrop-blur-sm transition-colors hover:border-iris/40 hover:text-iris"
                  >
                    Sign in
                  </motion.a>
                </Magnetic>
              </>
            ) : (
              <>
                <Magnetic>
                  <motion.a
                    href="#waitlist"
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    className="group inline-flex items-center gap-2 rounded-full bg-cream px-7 py-3.5 text-[15px] font-semibold text-ink shadow-[0_8px_30px_-8px_rgba(245,245,247,0.35)] transition-colors hover:bg-white"
                  >
                    Join the waitlist
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </motion.a>
                </Magnetic>
                <Magnetic>
                  <motion.a
                    href="#pipeline"
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    className="group inline-flex items-center gap-2 rounded-full border border-cream/25 bg-ink/40 px-7 py-3.5 text-[15px] font-medium text-cream backdrop-blur-sm transition-colors hover:border-iris/40 hover:text-iris"
                  >
                    See the pipeline
                    <ArrowDown className="h-4 w-4 transition-transform group-hover:translate-y-0.5" />
                  </motion.a>
                </Magnetic>
              </>
            )}
          </div>
        </Reveal>

        <Reveal delay={0.4}>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
            <Chip>4 agents</Chip>
            <Chip amber>1 human checkpoint</Chip>
            <Chip>0 broken links shipped</Chip>
          </div>
        </Reveal>
      </div>

      {/* the product, tilted by scroll */}
      <motion.div
        style={{ rotateX, scale, y, transformPerspective: 1400 }}
        className="relative z-10 mx-auto mt-16 max-w-5xl px-6"
      >
        <DashboardMock />
      </motion.div>

      <Reveal delay={0.2}>
        <p className="relative z-10 mt-10 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-dim/50">
          this is run #0042 — the product below is what you get, not a promise of it
        </p>
      </Reveal>
    </section>
  );
}
