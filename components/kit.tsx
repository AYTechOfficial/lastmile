import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/* The application's primitives.

   Deliberately presentational and hook-free so they work from both server and
   client components — if a piece needs state it gets its own file under
   components/app/. Everything here is a thin composition of tokens: no glows,
   no gradients-as-decoration, no colour that does not mean something. */

export type Tone = "neutral" | "brand" | "pass" | "warn" | "bad" | "info";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-t2",
  brand: "text-brand",
  pass: "text-pass",
  warn: "text-warn",
  bad: "text-bad",
  info: "text-info",
};

const TONE_CHIP: Record<Tone, string> = {
  neutral: "border-edge bg-surface2 text-t2",
  brand: "border-brand/30 bg-brand/10 text-brand",
  pass: "border-pass/30 bg-pass/10 text-pass",
  warn: "border-warn/30 bg-warn/10 text-warn",
  bad: "border-bad/30 bg-bad/10 text-bad",
  info: "border-info/30 bg-info/10 text-info",
};

export const toneText = (t: Tone) => TONE_TEXT[t];

/* ————————————————————————— surfaces ————————————————————————— */

export function Panel({
  children,
  className,
  tone = "flat",
}: {
  children: ReactNode;
  className?: string;
  /** flat = base surface, raised = one step up, well = recessed (logs, code) */
  tone?: "flat" | "raised" | "well";
}) {
  return (
    <div
      className={cn(
        tone === "flat" && "panel",
        tone === "raised" && "panel-2",
        tone === "well" && "well",
        "rounded-[14px]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Panel with a labelled header strip — the workhorse of the dashboard. */
export function Section({
  label,
  actions,
  children,
  className,
  bodyClassName,
  dense,
}: {
  label: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  dense?: boolean;
}) {
  return (
    <Panel className={className}>
      <header className="flex items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
        <span className="eyebrow eyebrow-strong">{label}</span>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className={cn(dense ? "p-0" : "p-4", bodyClassName)}>{children}</div>
    </Panel>
  );
}

/* ————————————————————————— text ————————————————————————— */

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("eyebrow", className)}>{children}</p>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-edge bg-surface2 px-1.5 font-mono text-[10px] leading-none text-t3">
      {children}
    </kbd>
  );
}

/* ————————————————————————— controls ————————————————————————— */

type Variant = "primary" | "brand" | "outline" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "bg-t1 text-app hover:bg-white border border-transparent",
  brand: "bg-brand text-white hover:bg-brand/90 border border-transparent shadow-[0_1px_0_0_rgba(255,255,255,0.12)_inset]",
  outline: "border border-edge bg-surface2 text-t1 hover:border-edge2 hover:bg-surface3",
  ghost: "border border-transparent text-t2 hover:bg-surface2 hover:text-t1",
  danger: "border border-bad/30 bg-bad/10 text-bad hover:bg-bad/15",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-[12.5px] gap-1.5 rounded-[9px]",
  md: "h-9 px-3.5 text-[13px] gap-2 rounded-[10px]",
  lg: "h-11 px-5 text-[14px] gap-2 rounded-[12px]",
};

/** Class builder so <button> and <Link> stay visually identical. */
export function btn(variant: Variant = "outline", size: Size = "md", className?: string): string {
  return cn(
    "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium",
    "transition-[background-color,border-color,color,opacity] duration-150",
    "disabled:pointer-events-none disabled:opacity-45",
    VARIANT[variant],
    SIZE[size],
    className,
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
  dot,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] font-mono text-[9.5px] uppercase tracking-[0.12em]",
        TONE_CHIP[tone],
        className,
      )}
    >
      {dot ? <span className="live-dot h-1 w-1" /> : null}
      {children}
    </span>
  );
}

/* ————————————————————————— data display ————————————————————————— */

export function Meter({
  value,
  tone = "brand",
  className,
  height = 3,
}: {
  /** 0..1 */
  value: number;
  tone?: Tone;
  className?: string;
  height?: number;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const fill =
    tone === "pass"
      ? "bg-pass"
      : tone === "warn"
        ? "bg-warn"
        : tone === "bad"
          ? "bg-bad"
          : tone === "info"
            ? "bg-info"
            : "bg-brand";
  return (
    <div
      className={cn("w-full overflow-hidden rounded-full bg-white/[0.07]", className)}
      style={{ height }}
      role="presentation"
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-700 ease-out", fill)}
        style={{ width: pct + "%" }}
      />
    </div>
  );
}

/** Telemetry row: label left, value right, optional hint under the value. */
export function Metric({
  label,
  value,
  hint,
  tone = "neutral",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 py-1.5", className)}>
      <span className="text-[12px] text-t3">{label}</span>
      <span className={cn("tnum font-mono text-[12px]", TONE_TEXT[tone])}>{value}</span>
      {hint ? <span className="sr-only">{hint}</span> : null}
    </div>
  );
}

/** Inline sparkline — no dependency, no axis, just shape. */
export function Sparkline({
  points,
  tone = "brand",
  width = 120,
  height = 28,
  className,
}: {
  points: number[];
  tone?: Tone;
  width?: number;
  height?: number;
  className?: string;
}) {
  if (points.length < 2) {
    return <div className={cn("h-7 w-full rounded bg-white/[0.03]", className)} />;
  }
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const y = (v: number) => height - 3 - ((v - min) / span) * (height - 6);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const stroke =
    tone === "pass" ? "var(--app-pass)" : tone === "warn" ? "var(--app-warn)" : tone === "info" ? "var(--app-info)" : "var(--app-brand)";

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={cn("w-full", className)} preserveAspectRatio="none" aria-hidden>
      <path d={area} fill={stroke} opacity={0.12} />
      <path d={line} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ————————————————————————— empty states ————————————————————————— */

export function Empty({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      {icon ? (
        <span className="mb-3.5 flex h-11 w-11 items-center justify-center rounded-[13px] border border-edge bg-surface2 text-t3">
          {icon}
        </span>
      ) : null}
      <p className="display text-[16px] font-medium text-t1">{title}</p>
      {body ? <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-t3">{body}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/* ————————————————————————— skeletons ————————————————————————— */

export function Bar({ w = "100%", h = 10, className }: { w?: string | number; h?: number; className?: string }) {
  return (
    <div
      className={cn("skeleton rounded", className)}
      style={{ width: typeof w === "number" ? w + "px" : w, height: h }}
    />
  );
}
