"use client";

import {
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
} from "motion/react";
import { cn } from "@/lib/cn";
export { cn };
import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";


/* ———————————————————————————— reveal on scroll ———————————————————————————— */

export function Reveal({
  children,
  className,
  delay = 0,
  y = 28,
  once = true,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
  once?: boolean;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, y: reduce ? 0 : y, filter: reduce ? "none" : "blur(8px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once, margin: "-70px" }}
      transition={{ duration: 0.85, delay, ease: [0.22, 1, 0.36, 1] }}
      onAnimationComplete={() => {
        // release the GPU layer once settled — a lingering blur(0px) filter
        // costs compositing on a long page
        if (ref.current) ref.current.style.filter = "none";
      }}
    >
      {children}
    </motion.div>
  );
}

/* ———————————————————————————— scroll progress bar ———————————————————————————— */

export function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 120, damping: 24, mass: 0.3 });
  return (
    <motion.div
      aria-hidden
      style={{ scaleX }}
      className="fixed inset-x-0 top-0 z-[70] h-[2px] origin-left bg-gradient-to-r from-iris via-iris to-cyan"
    />
  );
}

/* ———————————————————————————— mouse glow (desktop) ———————————————————————————— */

export function MouseGlow() {
  const reduce = useReducedMotion();
  const x = useMotionValue(-600);
  const y = useMotionValue(-600);
  const sx = useSpring(x, { stiffness: 60, damping: 18, mass: 0.6 });
  const sy = useSpring(y, { stiffness: 60, damping: 18, mass: 0.6 });

  useEffect(() => {
    if (reduce) return;
    const move = (e: PointerEvent) => {
      x.set(e.clientX - 300);
      y.set(e.clientY - 300);
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, [reduce, x, y]);

  if (reduce) return null;
  return (
    <motion.div
      aria-hidden
      style={{ x: sx, y: sy }}
      className="pointer-events-none fixed left-0 top-0 z-0 hidden h-[600px] w-[600px] rounded-full bg-[radial-gradient(closest-side,rgba(133,131,255,0.07),transparent_70%)] [@media(pointer:fine)]:block"
    />
  );
}

/* ———————————————————————————— spotlight card ———————————————————————————— */

export function SpotlightCard({
  children,
  className,
  radius = 280,
}: {
  children: ReactNode;
  className?: string;
  radius?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  function onMove(e: MouseEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - rect.left}px`);
    el.style.setProperty("--my", `${e.clientY - rect.top}px`);
  }

  function onLeave() {
    ref.current?.style.setProperty("--mx", "-9999px");
    ref.current?.style.setProperty("--my", "-9999px");
  }

  return (
    <div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={cn("group/spot relative overflow-hidden", className)}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover/spot:opacity-100"
        style={{
          background: `radial-gradient(${radius}px circle at var(--mx, -9999px) var(--my, -9999px), rgba(133,131,255,0.09), transparent 70%)`,
        }}
      />
      {children}
    </div>
  );
}

/* ———————————————————————————— section heading ———————————————————————————— */

export function Kicker({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-iris">
      <span aria-hidden className="inline-block h-px w-7 bg-iris/60" />
      {children}
    </p>
  );
}

export function SectionHead({
  kicker,
  title,
  sub,
  align = "left",
  className,
}: {
  kicker: string;
  title: ReactNode;
  sub?: ReactNode;
  align?: "left" | "center";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-5",
        align === "center" && "items-center text-center",
        className,
      )}
    >
      <Reveal>
        <Kicker>{kicker}</Kicker>
      </Reveal>
      <Reveal delay={0.08}>
        <h2 className="max-w-3xl text-4xl font-semibold leading-[1.04] tracking-tight text-cream md:text-6xl">
          {title}
        </h2>
      </Reveal>
      {sub ? (
        <Reveal delay={0.16}>
          <p className="max-w-2xl text-base leading-relaxed text-dim md:text-lg">{sub}</p>
        </Reveal>
      ) : null}
    </div>
  );
}

/* ———————————————————————————— magnetic hover ———————————————————————————— */

export function Magnetic({
  children,
  strength = 0.25,
  className,
}: {
  children: ReactNode;
  strength?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 180, damping: 14, mass: 0.4 });
  const sy = useSpring(y, { stiffness: 180, damping: 14, mass: 0.4 });

  function onMove(e: MouseEvent<HTMLDivElement>) {
    if (reduce || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    x.set((e.clientX - (rect.left + rect.width / 2)) * strength);
    y.set((e.clientY - (rect.top + rect.height / 2)) * strength);
  }

  function onLeave() {
    x.set(0);
    y.set(0);
  }

  return (
    <motion.div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={{ x: sx, y: sy }}
      className={cn("inline-block", className)}
    >
      {children}
    </motion.div>
  );
}

/* ———————————————————————————— small chips ———————————————————————————— */

export function Chip({ children, amber }: { children: ReactNode; amber?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-[10.5px] uppercase tracking-[0.14em]",
        amber ? "border-amber/30 text-amber" : "border-line text-dim",
      )}
    >
      {children}
    </span>
  );
}

/* ———————————————————————————— synced scroll state helper ———————————————————————————— */

export function useScrollStep(
  progress: ReturnType<typeof useScroll>["scrollYProgress"],
  steps: number,
  setter: (n: number) => void,
) {
  useMotionValueEvent(progress, "change", (v) => {
    setter(Math.min(steps - 1, Math.max(0, Math.floor(v * steps))));
  });
}
