"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { cn } from "@/components/ui";

/* The product, rendered as a real interface — the same dashboard a run
   actually shows: stages stepping, flows passing, a terminal streaming.
   Everything is HTML/CSS, so it stays crisp at any DPI. */

const TERMINAL: { text: string; tone?: "iris" | "amber" }[] = [
  { text: "$ lastmile run \"a crm for freelance photographers\"" },
  { text: "→ research   14 sources · 6 comparable products" },
  { text: "→ spec       4 core flows · 12 acceptance criteria" },
  { text: "◆ approve    spec approved by you · 2 min", tone: "amber" },
  { text: "→ build      41 files · next.js 15 · github push ok" },
  { text: "→ deploy     vercel · live in 38s" },
  { text: "→ verify     flow 3 failing · patching auth redirect", tone: "amber" },
  { text: "→ verify     re-deploy · re-testing all flows" },
  { text: "✓ verified   4/4 core flows passing · link ready", tone: "iris" },
];

const FLOWS = [
  { name: "Signup → login → dashboard", n: 4, time: "1.9s", status: "pass" },
  { name: "Create project · persists on reload", n: 6, time: "2.4s", status: "pass" },
  { name: "Invite teammate by email", n: 5, time: "2m 14s", status: "fixed" },
  { name: "Payment stub renders in checkout", n: 3, time: "0.8s", status: "pass" },
] as const;

function Terminal() {
  const [count, setCount] = useState(4);
  useEffect(() => {
    const id = setInterval(() => setCount((c) => (c > TERMINAL.length + 3 ? 4 : c + 1)), 1100);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-black/50">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <p className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-dim/70">
          pipeline · run #0042
        </p>
        <p className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-dim/70">bash</p>
      </div>
      <div className="h-[132px] space-y-1 overflow-hidden p-3 font-mono text-[10.5px] leading-relaxed">
        {TERMINAL.slice(0, Math.min(count, TERMINAL.length)).map((l) => (
          <motion.p
            key={l.text}
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3 }}
            className={cn(
              "truncate",
              l.tone === "iris" ? "text-iris" : l.tone === "amber" ? "text-amber" : "text-dim",
            )}
          >
            {l.text}
          </motion.p>
        ))}
      </div>
    </div>
  );
}

function Stepper() {
  const steps = [
    { id: "01", label: "Research", state: "done", time: "3m 12s" },
    { id: "02", label: "Spec", state: "done", time: "2m 40s" },
    { id: "◆", label: "Approved", state: "amber", time: "by you" },
    { id: "03", label: "Build", state: "done", time: "11m 02s" },
    { id: "04", label: "Deploy & Verify", state: "active", time: "live" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
      {steps.map((s, i) => (
        <div key={s.id} className="flex items-center gap-2">
          {i > 0 ? <span className="h-px w-4 bg-line" /> : null}
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.12em]",
              s.state === "done" && "border-line bg-panel text-dim",
              s.state === "amber" && "border-amber/40 bg-amber/10 text-amber",
              s.state === "active" &&
                "border-iris/50 bg-iris/10 text-iris shadow-[0_0_18px_-4px_rgba(133,131,255,0.5)]",
            )}
          >
            {s.state === "done" ? (
              <svg viewBox="0 0 12 12" className="h-2.5 w-2.5">
                <path
                  d="M2 6.5 4.8 9 10 3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <span>{s.id}</span>
            )}
            {s.label}
            <span className="text-dim/60">· {s.time}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function Ring() {
  return (
    <div className="relative mx-auto h-[92px] w-[92px]">
      <svg viewBox="0 0 92 92" className="h-full w-full -rotate-90">
        <circle cx="46" cy="46" r="40" fill="none" stroke="rgba(245,245,247,0.08)" strokeWidth="6" />
        <motion.circle
          cx="46"
          cy="46"
          r="40"
          fill="none"
          stroke="#8583ff"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={2 * Math.PI * 40}
          initial={{ strokeDashoffset: 2 * Math.PI * 40 }}
          whileInView={{ strokeDashoffset: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 1.6, ease: [0.22, 1, 0.36, 1], delay: 0.4 }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <p className="text-xl font-semibold text-cream">4/4</p>
        <p className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-dim">flows</p>
      </div>
    </div>
  );
}

export function DashboardMock() {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_60px_160px_-40px_rgba(0,0,0,0.9),0_0_80px_-30px_rgba(133,131,255,0.25)]">
      {/* window chrome */}
      <div className="flex items-center gap-3 border-b border-line bg-raise/40 px-4 py-2.5">
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-fail/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-iris/70" />
        </div>
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-line bg-ink/60 px-2.5 py-1">
          <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none">
            <rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2" className="text-dim" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" className="text-dim" />
          </svg>
          <p className="truncate font-mono text-[10px] tracking-wide text-dim">
            photographer-crm.vercel.app
          </p>
          <span className="ml-1 shrink-0 rounded-full border border-iris/40 bg-iris/10 px-1.5 py-px font-mono text-[8.5px] uppercase tracking-wider text-iris">
            verified
          </span>
        </div>
        <span className="ml-auto hidden shrink-0 items-center gap-1.5 rounded-full border border-iris/30 bg-iris/10 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.16em] text-iris sm:flex">
          <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-iris" />
          live
        </span>
      </div>

      <div className="grid md:grid-cols-[168px_1fr] lg:grid-cols-[168px_1fr_188px]">
        {/* sidebar */}
        <aside className="hidden border-r border-line p-3 md:block">
          <div className="flex items-center gap-2 rounded-lg bg-iris/10 px-2.5 py-2">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none">
              <path
                d="M4 13.5 9.5 19 20 6.5"
                stroke="#8583ff"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[12px] font-semibold text-cream">lastmile</span>
          </div>
          {["Overview", "Stages", "Proof Pack", "Costs", "Settings"].map((item, i) => (
            <p
              key={item}
              className={cn(
                "mt-1 rounded-lg px-2.5 py-2 text-[12px]",
                i === 0 ? "bg-white/[0.04] text-cream" : "text-dim/70",
              )}
            >
              {item}
            </p>
          ))}
          <div className="mt-4 rounded-lg border border-line bg-ink/50 p-2.5">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-dim/70">run</p>
            <p className="mt-1 font-mono text-[11px] text-cream">#0042 · $1.87</p>
          </div>
        </aside>

        {/* main */}
        <div className="min-w-0 space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[14px] font-semibold text-cream">CRM for freelance photographers</p>
              <p className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-dim/70">
                run #0042 · started 14 min ago
              </p>
            </div>
            <span className="rounded-full border border-line bg-ink/60 px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-dim">
              next.js 15 · your github
            </span>
          </div>

          <Stepper />

          <div className="space-y-2">
            {FLOWS.map((f, i) => (
              <motion.div
                key={f.name}
                initial={{ opacity: 0, y: 8 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: 0.3 + i * 0.15 }}
                className="flex items-center justify-between gap-3 rounded-lg border border-line bg-ink/60 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-medium text-cream">{f.name}</p>
                  <p className="font-mono text-[9px] tracking-wide text-dim/60">
                    {f.n} assertions · chromium
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-[9px] text-dim/60">{f.time}</span>
                  {f.status === "fixed" ? (
                    <span className="rounded-full border border-amber/40 bg-amber/10 px-2 py-0.5 font-mono text-[8.5px] uppercase tracking-wider text-amber">
                      fixed · att 2
                    </span>
                  ) : (
                    <span className="rounded-full border border-iris/40 bg-iris/10 px-2 py-0.5 font-mono text-[8.5px] uppercase tracking-wider text-iris">
                      pass
                    </span>
                  )}
                </div>
              </motion.div>
            ))}
          </div>

          <Terminal />
        </div>

        {/* right rail */}
        <aside className="hidden border-l border-line p-4 lg:block">
          <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-dim/70">
            verification
          </p>
          <div className="mt-3">
            <Ring />
          </div>
          <div className="mt-4 space-y-2">
            {[
              { k: "deploys", v: "2" },
              { k: "auto-fixes", v: "1" },
              { k: "console errors", v: "0" },
              { k: "network 4xx/5xx", v: "0" },
              { k: "tokens", v: "412k" },
              { k: "cost", v: "$1.87" },
            ].map((s) => (
              <div key={s.k} className="flex items-center justify-between border-b border-line/60 pb-1.5">
                <span className="text-[11px] text-dim">{s.k}</span>
                <span className="font-mono text-[11px] text-cream">{s.v}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-lg border border-iris/25 bg-iris/[0.06] p-2.5">
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-iris">
              proof pack
            </p>
            <p className="mt-1 text-[11px] leading-snug text-dim">
              12 screenshots · trace · logs attached
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
