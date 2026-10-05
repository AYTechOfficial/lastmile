"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronRight, FileText, Check } from "lucide-react";
import { Panel } from "@/components/kit";
import type { RunStateDTO } from "@/lib/run-dto";
import { Orchestrator } from "@/components/app/orchestrator/orchestrator";
import { RunStatus } from "./run-status";
import { SpecReview } from "./spec-review";
import { StageRail } from "./stage-rail";
import { Telemetry } from "./telemetry";
import { STAGE_ORDER, stageIndex } from "./status";

const pad = (n: number) => "#" + String(n).padStart(4, "0");

/* The build view. Two modes, honestly distinct:
     awaiting_approval — the spec is the decision in front of you
     everything else   — the Orchestrator Panel is the whole show            */
export function RunView({ initial }: { initial: RunStateDTO }) {
  const router = useRouter();
  // the Orchestrator owns live updates over SSE; this shell re-renders from
  // the server snapshot, so `initial` IS the state here.
  const state = initial;
  const [now, setNow] = useState(0);
  const lastStatus = useRef(initial.run.status);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  // keep the server-rendered rail (run list) in step with stage changes
  useEffect(() => {
    if (lastStatus.current === state.run.status) return;
    lastStatus.current = state.run.status;
    router.refresh();
  }, [state.run.status, router]);

  const run = state.run;
  const awaiting = run.status === "awaiting_approval";

  return (
    <div className="space-y-5">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-t3 transition-colors hover:text-brand"
      >
        <ArrowLeft className="h-3 w-3" />
        all runs
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="tnum font-mono text-[11px] text-t3">run {pad(run.runNumber)}</span>
            <RunStatus status={run.status} />
            {run.engine === "live" ? (
              <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-t3">autonomous pipeline</span>
            ) : null}
          </div>
          <h1 className="display mt-2 text-[24px] font-semibold leading-tight tracking-[-0.03em] text-t1 md:text-[30px]">
            {run.title}
          </h1>
        </div>
      </div>

      <StageRail status={run.status} currentStage={run.currentStage} events={state.events} />

      {awaiting && state.spec ? (
        <div className="rise">
          <SpecReview runId={run.id} spec={state.spec} />
        </div>
      ) : null}

      {!awaiting ? (
        <>
          <Orchestrator initial={state} onRefreshChrome={() => router.refresh()} />
          <aside className="lg:hidden">
            <Telemetry run={run} agents={state.agents} now={now} />
          </aside>
        </>
      ) : (
        <aside className="lg:grid">
          <Telemetry run={run} agents={state.agents} now={now} />
        </aside>
      )}

      {run.status === "done" && run.repoUrl ? (
        <p className="pt-2 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-t3">
          code pushed to {run.repoUrl.replace(/^https?:\/\//, "")} · you own the repository
        </p>
      ) : null}

      {run.status === "failed" ? (
        <p className="pt-2 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-t3">
          stopped at the {STAGE_ORDER[stageIndex(run.status, run.currentStage)]} stage
        </p>
      ) : null}
    </div>
  );
}

/* After approval the spec folds away — it is reference material from then on,
   not the decision in front of you. Kept for the report tab parity. */
export function SpecSummary({ spec }: { spec: NonNullable<RunStateDTO["spec"]> }) {
  return (
    <Panel className="overflow-hidden">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5">
          <span className="flex items-center gap-2.5">
            <FileText className="h-3.5 w-3.5 text-t3" />
            <span className="eyebrow eyebrow-strong">Spec v{spec.variant}</span>
            <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-t3">
              {spec.flows.length} flows · {spec.acceptance} assertions
            </span>
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-t3 transition-transform group-open:rotate-90" />
        </summary>
        <div className="border-t border-edge p-4">
          <p className="text-[13px] leading-relaxed text-t2">{spec.summary}</p>
          <div className="mt-3 space-y-2">
            {spec.flows.map((f, i) => (
              <div key={f.name} className="rounded-[10px] border border-edge bg-well/50 px-3.5 py-2.5">
                <p className="text-[12.5px] font-medium text-t1">
                  <span className="tnum mr-2 font-mono text-[10px] text-brand">{String(i + 1).padStart(2, "0")}</span>
                  {f.name}
                </p>
                <ul className="mt-1.5 space-y-0.5 pl-[26px]">
                  {f.criteria.map((c) => (
                    <li key={c} className="flex gap-2 text-[11.5px] leading-snug text-t3">
                      <Check className="mt-[3px] h-2.5 w-2.5 shrink-0 text-pass/60" strokeWidth={3} />
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </details>
    </Panel>
  );
}
