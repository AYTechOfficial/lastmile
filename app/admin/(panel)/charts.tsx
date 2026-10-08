import type { ReactNode } from "react";

/* Charts, drawn as SVG.

   No charting dependency: the panel needs four shapes — a bar series, a line, a
   small sparkline and a proportion bar — and pulling in a library for that would
   cost a build step, a bundle and a licence to draw a rectangle. These render on
   the server and are readable as text, which is also why each one carries its
   values in the markup rather than only in pixels. */

export function Stat({
  label,
  value,
  sub,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: ReactNode;
  tone?: "neutral" | "brand" | "pass" | "warn" | "bad";
}) {
  const accent: Record<string, string> = {
    neutral: "text-t1",
    brand: "text-brand",
    pass: "text-pass",
    warn: "text-warn",
    bad: "text-bad",
  };
  return (
    <div className="rounded-[14px] border border-edge bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="eyebrow">{label}</p>
        <span className="text-t3">{icon}</span>
      </div>
      <p className={"tnum mt-2 font-mono text-[24px] font-semibold " + accent[tone]}>{value}</p>
      {sub ? <p className="mt-1 text-[11.5px] text-t3">{sub}</p> : null}
    </div>
  );
}

/** A bar series over time. Two series at most: these charts answer "how much,
    and when", and a third colour stops answering anything. */
export function BarSeries({
  points,
  height = 132,
  format,
  color = "var(--color-brand, #4f8cff)",
  label,
}: {
  points: { label: string; value: number }[];
  height?: number;
  format: (value: number) => string;
  color?: string;
  label: string;
}) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const total = points.reduce((sum, p) => sum + p.value, 0);

  return (
    <figure className="space-y-2">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-[12.5px] font-medium text-t2">{label}</span>
        <span className="tnum font-mono text-[11.5px] text-t3">
          {format(total)} over {points.length} days
        </span>
      </figcaption>
      <div className="flex items-end gap-[3px]" style={{ height }}>
        {points.map((p) => {
          const pct = (p.value / max) * 100;
          return (
            <div key={p.label} className="group relative flex flex-1 flex-col justify-end">
              <div
                className="w-full rounded-t-[3px] transition-colors"
                style={{
                  height: `${Math.max(pct, p.value > 0 ? 4 : 1.5)}%`,
                  background: p.value > 0 ? color : "color-mix(in oklab, currentColor 12%, transparent)",
                  opacity: p.value > 0 ? 0.85 : 0.35,
                }}
                title={`${p.label}: ${format(p.value)}`}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between font-mono text-[10px] text-t3">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </figure>
  );
}

/** A filled line, for a rate rather than a quantity (score, latency). */
export function Sparkline({
  points,
  height = 64,
  format,
  color = "var(--color-brand, #4f8cff)",
  label,
}: {
  points: { label: string; value: number }[];
  height?: number;
  format: (value: number) => string;
  color?: string;
  label: string;
}) {
  const values = points.map((p) => p.value);
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const width = 300;
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const coords = values.map((v, i) => [i * step, height - ((v - min) / span) * (height - 8) - 4] as const);
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const last = values[values.length - 1] ?? 0;

  return (
    <figure className="space-y-2">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-[12.5px] font-medium text-t2">{label}</span>
        <span className="tnum font-mono text-[11.5px] text-t3">{format(last)}</span>
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-16 w-full" role="img" aria-label={`${label}: ${format(last)}`}>
        <path d={area} fill={color} opacity="0.12" />
        <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between font-mono text-[10px] text-t3">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </figure>
  );
}

/** A single horizontal proportion — the honest way to show a share of a whole. */
export function Proportion({
  label,
  value,
  total,
  format,
  color = "var(--color-brand, #4f8cff)",
}: {
  label: string;
  value: number;
  total: number;
  format: (value: number) => string;
  color?: string;
}) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[12px] text-t2">{label}</span>
        <span className="tnum shrink-0 font-mono text-[11px] text-t3">
          {format(value)} · {pct.toFixed(0)}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

export function SectionCard({
  title,
  hint,
  action,
  children,
  className,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"rounded-[14px] border border-edge bg-surface p-5 " + (className ?? "")}>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="display text-[14.5px] font-semibold text-t1">{title}</h2>
          {hint ? <p className="mt-1 text-[11.5px] text-t3">{hint}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
