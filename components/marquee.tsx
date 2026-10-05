const ITEMS = [
  "one sentence in",
  "real-time competitive research",
  "the PRD, written properly",
  "you approve the spec",
  "full codebase → your github",
  "deploy to your vercel",
  "test the live url",
  "fails → fixes → re-tests",
  "a working link, already checked",
];

export function Marquee() {
  const row = [...ITEMS, ...ITEMS];
  return (
    <section aria-hidden className="marquee-paused overflow-hidden border-y border-line bg-deep/50 py-4">
      <div className="animate-marquee flex w-max items-center gap-8 pr-8">
        {row.map((item, i) => (
          <span
            key={i}
            className="flex items-center gap-8 whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.22em] text-dim"
          >
            {item}
            <span className={i % 2 === 0 ? "text-iris/70" : "text-amber/70"}>◆</span>
          </span>
        ))}
      </div>
    </section>
  );
}
