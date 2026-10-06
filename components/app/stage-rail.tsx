"use client";

import { Check, FileSearch, FileText, FlaskConical, Hammer, Rocket, ScanSearch, Sparkles, UserCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { STAGE_META, STAGE_ORDER, stageIndex, statusMeta, type StageId } from "./status";
import type { RunEventDTO } from "@/lib/run-dto";

const ICON: Record<StageId, React.ComponentType<{ className?: string }>> = {
  research: FileSearch,
  spec: FileText,
  checkpoint: UserCheck,
  prompt: Sparkles,
  code: Hammer,
  verify: ScanSearch,
  deploy: Rocket,
  test: FlaskConical,
};

type RailState = "done" | "active" | "waiting" | "pending";

/* The six stages, left to right, with the time each one actually took. The
   rail is the run's spine: everything below it is evidence for one of its
   nodes. */
export function StageRail({
  status,
  currentStage,
  events,
}: {
  status: string;
  currentStage: string;
  events: RunEventDTO[];
}) {
  const current = stageIndex(status, currentStage);
  const meta = statusMeta(status);

  function stateOf(i: number): RailState {
    if (status === "done") return "done";
    if (status === "failed") return i <= current ? "done" : "pending";
    if (i < current) return "done";
    if (i === current) return status === "awaiting_approval" ? "waiting" : "active";
    return "pending";
  }

  function span(fromIso: string, toIso: string): string {
    const secs = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000));
    if (secs < 60) return secs + "s";
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s > 0 ? m + "m " + s + "s" : m + "m";
  }

  function duration(stage: StageId): string | null {
    // the checkpoint's interesting number is how long the human took, which is
    // spec-ready -> approved, not the zero-length span of the marker itself
    if (stage === "checkpoint") {
      const approved = events.find((e) => e.stage === "checkpoint");
      if (!approved) return status === "awaiting_approval" ? "with you" : null;
      const specEvents = events.filter((e) => e.stage === "spec");
      const ready = specEvents[specEvents.length - 1];
      return ready ? span(ready.at, approved.at) : null;
    }

    const evs = events.filter((e) => e.stage === stage);
    if (evs.length === 0) return null;
    return span(evs[0].at, evs[evs.length - 1].at);
  }

  return (
    <div className="panel rounded-[14px] px-3 py-4 md:px-5">
      <div className="flex items-start">
        {STAGE_ORDER.map((stage, i) => {
          const state = stateOf(i);
          const Icon = ICON[stage];
          const isLast = i === STAGE_ORDER.length - 1;
          const dur = duration(stage);
          const waitingAmber = state === "waiting";

          return (
            <div key={stage} className={cn("flex items-start", !isLast && "flex-1")}>
              <div className="flex w-[74px] shrink-0 flex-col items-center gap-1.5">
                <span
                  className={cn(
                    "relative flex h-9 w-9 items-center justify-center rounded-full border transition-colors duration-300",
                    state === "done" && "border-pass/30 bg-pass/10 text-pass",
                    state === "active" && "border-brand/50 bg-brand/15 text-brand",
                    waitingAmber && "border-warn/50 bg-warn/12 text-warn",
                    state === "pending" && "border-edge bg-surface2 text-t3",
                  )}
                >
                  {state === "active" ? (
                    <>
                      <span className="absolute inset-0 rounded-full border border-brand/40" />
                      <Icon className="h-4 w-4" />
                    </>
                  ) : state === "done" ? (
                    <Check className="h-4 w-4" strokeWidth={2.5} />
                  ) : (
                    <Icon className="h-4 w-4" />
                  )}
                </span>

                <span
                  className={cn(
                    "whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.1em]",
                    state === "active" && "text-brand",
                    waitingAmber && "text-warn",
                    state === "done" && "text-t3",
                    state === "pending" && "text-t3/60",
                  )}
                >
                  {STAGE_META[stage].label}
                </span>
                <span className="tnum h-3 whitespace-nowrap font-mono text-[9px] text-t3/70">
                  {dur ?? ""}
                </span>
              </div>

              {!isLast ? (
                <div className="mt-[17px] h-[2px] min-w-3 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width] duration-700",
                      i < current || status === "done" ? "w-full bg-pass/50" : "bg-brand/60",
                    )}
                    style={{ width: i < current || status === "done" ? "100%" : state === "active" ? "100%" : "0%" }}
                  >
                    {state === "active" && meta.live ? (
                      <span className="relative block h-full w-full overflow-hidden">
                        <span className="sweep absolute inset-0" />
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <p className="mt-3.5 border-t border-edge pt-3 text-[12px] leading-relaxed text-t3">
        <span className={cn("font-medium", meta.tone === "warn" ? "text-warn" : "text-t2")}>
          {STAGE_META[STAGE_ORDER[current]].role}
        </span>
        {" — "}
        {STAGE_META[STAGE_ORDER[current]].hint}
      </p>
    </div>
  );
}
