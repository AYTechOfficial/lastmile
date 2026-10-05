"use client";

import { AnimatePresence, motion, useMotionValueEvent, useScroll } from "motion/react";
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { cn, ScrollProgress } from "@/components/ui";
import { signupOpen } from "@/lib/signup-mode";

const LINKS = [
  { href: "#why", label: "Why" },
  { href: "#pipeline", label: "Pipeline" },
  { href: "#proof", label: "Proof" },
  { href: "#compare", label: "Compare" },
  { href: "#faq", label: "FAQ" },
];

export function Wordmark({ className }: { className?: string }) {
  return (
    <a href="#top" className={cn("group flex items-center gap-2.5", className)}>
      <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-iris/40 bg-iris/10 transition-colors group-hover:bg-iris/20">
        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
          <path
            d="M4 13.5 9.5 19 20 6.5"
              stroke="#8583ff"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="text-[17px] font-semibold tracking-tight">
        lastmile
        <span className="text-iris">.</span>
      </span>
    </a>
  );
}

export function Nav({ authed = false }: { authed?: boolean }) {
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useMotionValueEvent(scrollY, "change", (v) => setScrolled(v > 14));

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-all duration-500",
        scrolled ? "border-b border-line bg-ink/80 backdrop-blur-xl" : "bg-transparent",
      )}
    >
      <ScrollProgress />
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Wordmark />

        <div className="hidden items-center gap-8 md:flex">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="font-mono text-[11px] uppercase tracking-[0.18em] text-dim transition-colors hover:text-iris"
            >
              {l.label}
            </a>
          ))}
          {authed ? (
            <a
              href="/dashboard"
              className="rounded-full bg-cream px-5 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-white"
            >
              Open dashboard
            </a>
          ) : signupOpen() ? (
            <>
              <a
                href="/login"
                className="font-mono text-[11px] uppercase tracking-[0.18em] text-dim transition-colors hover:text-iris"
              >
                Log in
              </a>
              <a
                href="/signup"
                className="rounded-full bg-cream px-5 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-white"
              >
                Get started
              </a>
            </>
          ) : (
            <>
              <a
                href="/login"
                className="font-mono text-[11px] uppercase tracking-[0.18em] text-dim transition-colors hover:text-iris"
              >
                Log in
              </a>
              <a
                href="#waitlist"
                className="rounded-full bg-cream px-5 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-white"
              >
                Join waitlist
              </a>
            </>
          )}
        </div>

        <button
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((o) => !o)}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-line text-cream md:hidden"
        >
          {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </button>
      </nav>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden border-b border-line bg-ink/95 backdrop-blur-xl md:hidden"
          >
            <div className="flex flex-col gap-1 px-6 py-4">
              {LINKS.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="rounded-lg px-3 py-3 font-mono text-xs uppercase tracking-[0.18em] text-dim transition-colors hover:bg-panel hover:text-iris"
                >
                  {l.label}
                </a>
              ))}
              {authed ? (
                <a
                  href="/dashboard"
                  onClick={() => setOpen(false)}
                  className="mt-2 rounded-full bg-cream px-5 py-3 text-center text-sm font-semibold text-ink"
                >
                  Open dashboard
                </a>
              ) : signupOpen() ? (
                <>
                  <a
                    href="/login"
                    onClick={() => setOpen(false)}
                    className="rounded-lg px-3 py-3 font-mono text-xs uppercase tracking-[0.18em] text-dim transition-colors hover:bg-panel hover:text-iris"
                  >
                    Log in
                  </a>
                  <a
                    href="/signup"
                    onClick={() => setOpen(false)}
                    className="mt-2 rounded-full bg-cream px-5 py-3 text-center text-sm font-semibold text-ink"
                  >
                    Get started
                  </a>
                </>
              ) : (
                <>
                  <a
                    href="/login"
                    onClick={() => setOpen(false)}
                    className="rounded-lg px-3 py-3 font-mono text-xs uppercase tracking-[0.18em] text-dim transition-colors hover:bg-panel hover:text-iris"
                  >
                    Log in
                  </a>
                  <a
                    href="#waitlist"
                    onClick={() => setOpen(false)}
                    className="mt-2 rounded-full bg-cream px-5 py-3 text-center text-sm font-semibold text-ink"
                  >
                    Join waitlist
                  </a>
                </>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
