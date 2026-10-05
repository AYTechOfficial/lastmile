"use client";

import { Check, Minus, X } from "lucide-react";
import { Reveal, SectionHead, cn } from "@/components/ui";

type Cell = { ok: boolean | null; note?: string };

const COLS = [
  "Fast first version",
  "Output you can ship",
  "Researches the market up front",
  "Re-checks the live URL, then fixes it",
];

const ROWS: { name: string; sub: string; cells: Cell[]; highlight?: boolean }[] = [
  {
    name: "Freelance developers",
    sub: "accurate, but slow and expensive",
    cells: [
      { ok: false, note: "slow" },
      { ok: true, note: "accurate" },
      { ok: null, note: "not addressed" },
      { ok: null, note: "manual — and you pay for it" },
    ],
  },
  {
    name: "No-code tools",
    sub: "bubble, webflow",
    cells: [
      { ok: true, note: "fast" },
      { ok: false, note: "limited and locked-in" },
      { ok: null, note: "not addressed" },
      { ok: false, note: "no" },
    ],
  },
  {
    name: "One-shot AI app-builders",
    sub: "bolt.new, lovable, replit agent",
    cells: [
      { ok: true, note: "fast" },
      { ok: false, note: "ships missing features, needs real cleanup" },
      { ok: false, note: "reactive only, never the whole spec" },
      { ok: false, note: "no" },
    ],
  },
  {
    name: "Autonomous coding agents",
    sub: "devin, by cognition",
    cells: [
      { ok: null, note: "not addressed" },
      { ok: false, note: "roughly 1 task in 4 needs a human" },
      { ok: false, note: "needs a scoped ticket and an existing codebase" },
      { ok: false, note: "no" },
    ],
  },
  {
    name: "LastMile",
    sub: "this pipeline",
    highlight: true,
    cells: [
      { ok: true, note: "one sentence in" },
      { ok: true, note: "verified before handover" },
      { ok: true, note: "stage 01, before any code" },
      { ok: true, note: "stage 04 — and it loops until it passes" },
    ],
  },
];

function CellMark({ cell }: { cell: Cell }) {
  return (
    <div>
      {cell.ok === true ? (
        <Check className="h-4 w-4 text-iris" strokeWidth={2.5} />
      ) : cell.ok === false ? (
        <X className="h-4 w-4 text-fail" strokeWidth={2.5} />
      ) : (
        <Minus className="h-4 w-4 text-dim/50" strokeWidth={2.5} />
      )}
      {cell.note ? (
        <p
          className={cn(
            "mt-1.5 max-w-[180px] text-[12px] leading-snug",
            cell.ok === true ? "text-iris/80" : "text-dim/75",
          )}
        >
          {cell.note}
        </p>
      ) : null}
    </div>
  );
}

export function Compare() {
  return (
    <section id="compare" className="relative bg-deep/40 py-28 md:py-40">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHead
          kicker="The honest table"
          title={
            <>
              Every route to a working product.{" "}
              <span className="serif-accent text-iris">One closes the loop.</span>
            </>
          }
          sub="No strawmen — each row is how the route actually behaves today. The last column is the one nobody else performs."
        />

        <Reveal delay={0.1}>
          <div className="relative mt-14">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-deep to-transparent md:hidden"
            />
            <p className="mb-3 text-right font-mono text-[10px] uppercase tracking-[0.18em] text-dim/60 md:hidden">
              swipe to compare →
            </p>
            <div className="overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:thin]">
            <table className="w-full min-w-[920px] border-collapse text-left">
              <thead>
                <tr>
                  <th className="pb-5 pr-6 font-mono text-[10.5px] font-medium uppercase tracking-[0.2em] text-dim">
                    Route to a working product
                  </th>
                  {COLS.map((c) => (
                    <th
                      key={c}
                      className="pb-5 pr-6 align-bottom font-mono text-[10.5px] font-medium uppercase leading-relaxed tracking-[0.2em] text-dim"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr
                    key={row.name}
                    className={cn(
                      "border-t transition-colors",
                      row.highlight
                        ? "border-iris/35 bg-iris/[0.05]"
                        : "border-line hover:bg-cream/[0.02]",
                    )}
                  >
                    <td className="py-6 pr-6 align-top">
                      <p
                        className={cn(
                          "text-[15px] font-semibold",
                          row.highlight ? "text-iris" : "text-cream",
                        )}
                      >
                        {row.name}
                      </p>
                      <p className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.12em] text-dim/70">
                        {row.sub}
                      </p>
                    </td>
                    {row.cells.map((cell, i) => (
                      <td key={i} className="py-6 pr-6 align-top">
                        <CellMark cell={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.15}>
          <p className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-dim/70">
            <span className="flex items-center gap-2">
              <Check className="h-3 w-3 text-iris" /> does this
            </span>
            <span className="flex items-center gap-2">
              <X className="h-3 w-3 text-fail" /> doesn’t
            </span>
            <span className="flex items-center gap-2">
              <Minus className="h-3 w-3 text-dim/50" /> not claimed either way
            </span>
          </p>
        </Reveal>
      </div>
    </section>
  );
}
