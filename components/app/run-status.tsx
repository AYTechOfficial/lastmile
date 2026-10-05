import { cn } from "@/lib/cn";
import { statusMeta } from "./status";

/* The status chip. Colour is the semantic layer: brand = the pipeline is
   working, warn = it is waiting on you, pass = verified, bad = failed. */

export function RunStatus({
  status,
  className,
  size = "md",
}: {
  status: string;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const meta = statusMeta(status);
  const tone = {
    neutral: "border-edge bg-surface2 text-t3",
    brand: "border-brand/30 bg-brand/10 text-brand",
    pass: "border-pass/30 bg-pass/10 text-pass",
    warn: "border-warn/30 bg-warn/10 text-warn",
    bad: "border-bad/30 bg-bad/10 text-bad",
    info: "border-info/30 bg-info/10 text-info",
  }[meta.tone];

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border font-mono uppercase",
        size === "sm" && "px-2 py-[2px] text-[9px] tracking-[0.14em]",
        size === "md" && "px-2.5 py-1 text-[9.5px] tracking-[0.14em]",
        size === "lg" && "px-3 py-1.5 text-[10.5px] tracking-[0.14em]",
        tone,
        className,
      )}
    >
      {meta.live ? (
        <span className="live-dot h-1.5 w-1.5" />
      ) : (
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            meta.tone === "pass" && "bg-pass",
            meta.tone === "warn" && "bg-warn",
            meta.tone === "bad" && "bg-bad",
            meta.tone === "neutral" && "bg-t3",
          )}
        />
      )}
      {meta.label}
    </span>
  );
}
