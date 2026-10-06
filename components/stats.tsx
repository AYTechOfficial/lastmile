"use client";

import { animate, motion, useInView, useMotionValue, useTransform } from "motion/react";
import { useEffect, useRef } from "react";
import { Reveal, SectionHead } from "@/components/ui";

function CountUp({ to, format }: { to: number; format: (v: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const mv = useMotionValue(0);
  const text = useTransform(mv, (v) => format(v));

  useEffect(() => {
    if (!inView) return;
    const controls = animate(mv, to, { duration: 1.9, ease: [0.22, 1, 0.36, 1] });
    return () => controls.stop();
  }, [inView, mv, to]);

  return <motion.span ref={ref}>{text}</motion.span>;
}

const STATS = [
  { to: 4.7, format: (v: number) => `$${v.toFixed(1)}B`, label: "AI app-building market, 2026 est." },
  { to: 38, format: (v: number) => `${Math.round(v)}%/yr`, label: "market growth, roughly" },
  { to: 13.3, format: (v: number) => `$${v.toFixed(1)}B`, label: "lovable valuation · aug 2026" },
  { to: 9, format: (v: number) => `$${Math.round(v)}B`, label: "replit valuation · mar 2026" },
];

export function Stats() {
  return (
    <section className="relative py-28 md:py-36">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHead
          kicker="Why now"
          title={
            <>
              The market already voted.{" "}
              <span className="serif-accent text-iris">The last mile is empty.</span>
            </>
          }
          sub="Hundreds of millions in capital are riding “prompt to working app” — and the capital is right about the demand. It’s the “verified” part the industry skipped."
          align="center"
          className="mx-auto items-center"
        />

        <Reveal delay={0.12}>
          <div className="mt-16 grid grid-cols-2 gap-px overflow-hidden rounded-3xl border border-line bg-line lg:grid-cols-4">
            {STATS.map((s) => (
              <div key={s.label} className="bg-panel/80 px-6 py-10 text-center">
                <p className="text-4xl font-semibold tracking-tight text-iris md:text-5xl">
                  <CountUp to={s.to} format={s.format} />
                </p>
                <p className="mx-auto mt-3 max-w-[180px] font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-dim">
                  {s.label}
                </p>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delay={0.2}>
          <p className="mt-5 text-center font-mono text-[10.5px] uppercase tracking-[0.14em] text-dim/60">
            directional figures, as publicly reported — the direction is the point, not the decimal
          </p>
        </Reveal>
      </div>
    </section>
  );
}
