"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Pause, Play } from "lucide-react";
import { cn } from "@/lib/cn";
import { STAGE_META, type StageId } from "./status";
import { fmtClock, type RunEventDTO } from "@/lib/run-dto";

const TONE: Record<string, string> = {
  command: "text-t1 font-medium",
  info: "text-t2",
  success: "text-pass",
  warn: "text-warn",
  error: "text-bad",
  flow: "text-info",
  url: "text-brand",
};

const pad = (n: number) => "#" + String(n).padStart(4, "0");

/* The raw feed from the agents, wrapped in a terminal. This is the view people
   leave open — so it autoscrolls, but stops the moment you scroll up to read. */
export function ActivityLog({
  events,
  runNumber,
  live,
}: {
  events: RunEventDTO[];
  runNumber: number;
  live: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el || !pinned) return;
    el.scrollTop = el.scrollHeight;
  }, [events.length, pinned]);

  const grouped = useMemo(() => {
    const out: { stage: string; items: RunEventDTO[] }[] = [];
    for (const e of events) {
      const last = out[out.length - 1];
      if (last && last.stage === e.stage) last.items.push(e);
      else out.push({ stage: e.stage, items: [e] });
    }
    return out;
  }, [events]);

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setPinned(atBottom);
  }

  return (
    <div className="overflow-hidden rounded-[14px] border border-edge bg-well">
      <div className="flex items-center justify-between gap-3 border-b border-edge px-3.5 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="flex gap-1">
            <span className="h-2 w-2 rounded-full bg-bad/50" />
            <span className="h-2 w-2 rounded-full bg-warn/50" />
            <span className="h-2 w-2 rounded-full bg-pass/50" />
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-t3">
            pipeline · run {pad(runNumber)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {live && pinned ? (
            <span className="flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-2 py-[3px] font-mono text-[9px] uppercase tracking-[0.14em] text-brand">
              <span className="live-dot h-1.5 w-1.5" />
              live
            </span>
          ) : null}
          {live ? (
            <button
              type="button"
              onClick={() => setPinned((p) => !p)}
              title={pinned ? "Pause autoscroll" : "Follow output"}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-[7px] border transition-colors",
                pinned
                  ? "border-edge text-t3 hover:text-t1"
                  : "border-warn/40 bg-warn/10 text-warn",
              )}
            >
              {pinned ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            </button>
          ) : null}
        </div>
      </div>

      <div
        ref={ref}
        onScroll={onScroll}
        className="thin-scroll h-[300px] overflow-y-auto px-3.5 py-3 font-mono text-[11px] leading-[1.75]"
      >
        {events.length === 0 ? (
          <p className="text-t3">starting pipeline…</p>
        ) : (
          grouped.map((group, gi) => (
            <div key={group.stage + gi}>
              <div className="my-2 flex items-center gap-2.5 first:mt-0">
                <span className="eyebrow">
                  {STAGE_META[group.stage as StageId]?.role ?? group.stage}
                </span>
                <span className="h-px flex-1 bg-edge" />
              </div>
              <div className="space-y-[3px]">
                {group.items.map((e) => (
                  <p key={e.seq} className={cn("flex gap-3", TONE[e.kind] ?? "text-t2")}>
                    <span className="tnum shrink-0 select-none text-t3/50">{fmtClock(e.at)}</span>
                    <span className="min-w-0 whitespace-pre-wrap break-words">{e.line}</span>
                  </p>
                ))}
              </div>
            </div>
          ))
        )}

        {live ? (
          <p className="flex gap-3 text-t3">
            <span className="tnum shrink-0 text-t3/40">{fmtClock(new Date().toISOString())}</span>
            <span className="caret-inline" />
          </p>
        ) : null}
      </div>

      {!pinned && live ? (
        <button
          type="button"
          onClick={() => setPinned(true)}
          className="flex w-full items-center justify-center gap-1.5 border-t border-edge bg-surface2/60 py-2 text-[11px] text-brand transition-colors hover:bg-surface2"
        >
          <ArrowDownToLine className="h-3 w-3" />
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
