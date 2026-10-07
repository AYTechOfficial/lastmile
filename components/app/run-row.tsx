import Link from "next/link";
import { ArrowRight, ExternalLink } from "lucide-react";
import { cn } from "@/lib/cn";
import { Meter } from "@/components/kit";
import { fmtRelative, fmtTokens } from "@/lib/run-dto";
import { STAGE_META, STAGE_ORDER, isFinished, progressOf, stageIndex, statusMeta } from "./status";
import { RunStatus } from "./run-status";
import { RunDeleteButton } from "./run-row-actions";

const pad = (n: number) => "#" + String(n).padStart(4, "0");

export type RunListRow = {
  id: string;
  runNumber: number;
  title: string;
  status: string;
  currentStage: string;
  liveUrl: string | null;
  tokens: number;
  createdAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
};

/* A row, not a card. A list of runs is a list — cards would spend vertical
   space on padding that belongs to information. */
export function RunRow({ run }: { run: RunListRow }) {
  const meta = statusMeta(run.status);
  const finished = isFinished(run.status);
  const stage = STAGE_ORDER[stageIndex(run.status, run.currentStage)];
  const pct = Math.round(progressOf(run.status) * 100);

  return (
    <div className="group/row relative">
    <Link
      href={"/dashboard/runs/" + run.id}
      className="lift group relative grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-2 rounded-[12px] border border-transparent px-3 py-3 hover:bg-surface md:grid-cols-[54px_minmax(0,1fr)_132px_150px_20px] md:gap-x-5 md:px-4"
    >
      <span className="tnum hidden font-mono text-[11px] text-t3 md:block">{pad(run.runNumber)}</span>

      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="tnum font-mono text-[11px] text-t3 md:hidden">{pad(run.runNumber)}</span>
          <p className="truncate text-[14px] font-medium tracking-[-0.01em] text-t1">{run.title}</p>
        </div>
        <p className="mt-0.5 flex items-center gap-2 truncate font-mono text-[10.5px] text-t3">
          <span>{fmtRelative(typeof run.createdAt === "string" ? run.createdAt : run.createdAt.toISOString())}</span>
          {run.tokens > 0 ? (
            <>
              <span className="text-edge2">·</span>
              <span className="tnum">{fmtTokens(run.tokens)} tok</span>
            </>
          ) : null}
          {!finished ? (
            <>
              <span className="text-edge2">·</span>
              <span className={cn(meta.tone === "warn" ? "text-warn" : "text-brand")}>
                {STAGE_META[stage].label.toLowerCase()}
              </span>
            </>
          ) : null}
        </p>
      </div>

      <div className="order-last col-span-2 flex items-center md:order-none md:col-span-1 md:justify-end">
        <RunStatus status={run.status} size="sm" />
      </div>

      <div className="order-last col-span-2 flex min-w-0 items-center gap-3 md:order-none md:col-span-1">
        {run.status === "done" && run.liveUrl ? (
          <span className="flex min-w-0 items-center gap-1.5 text-pass">
            <ExternalLink className="h-3 w-3 shrink-0" />
            <span className="truncate font-mono text-[10.5px]">{run.liveUrl.replace(/^https?:\/\//, "")}</span>
          </span>
        ) : finished ? (
          <span className="font-mono text-[10.5px] text-t3">run ended</span>
        ) : (
          <>
            <Meter value={progressOf(run.status)} tone={meta.tone === "warn" ? "warn" : "brand"} />
            <span className="tnum shrink-0 font-mono text-[10px] text-t3">{pct}%</span>
          </>
        )}
      </div>

      <ArrowRight className="hidden h-3.5 w-3.5 text-t3 transition-all group-hover:translate-x-0.5 group-hover:text-brand md:block" />
    </Link>
    {/* delete lives outside the Link — a button inside a link would navigate */}
    <RunDeleteButton
      runId={run.id}
      className="absolute right-2 top-1/2 z-10 -translate-y-1/2 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100 md:right-3"
    />
  </div>
  );
}
