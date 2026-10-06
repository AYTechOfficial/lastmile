"use client";

import { useMemo } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/kit";
import { fmtClock, fmtDuration, type AgentDTO, type IssueDTO, type RunEventDTO } from "@/lib/run-dto";

/* The inspector: click any node and get that agent's real telemetry — its
   event lines, its model/tokens/timing, and the artifacts it produced. */

const AGENT_TITLES: Record<string, string> = {
  orchestrator: "Main Orchestrator",
  research: "Research Agent",
  spec: "Spec step",
  prompt: "Prompt Engineer",
  code: "Core Coding Agent",
  verify: "Verify Agent",
  deploy: "Deploy Agent",
  test: "Testing Agent",
};

export function AgentDrawer({
  agent,
  events,
  onClose,
  children,
}: {
  agent: string;
  events: RunEventDTO[];
  onClose: () => void;
  children: React.ReactNode;
}) {
  const lines = useMemo(() => events.filter((e) => e.stage === agent), [events, agent]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close inspector" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <aside className="relative flex h-full w-full max-w-[520px] flex-col border-l border-edge bg-app shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-edge px-5 py-4">
          <div>
            <p className="eyebrow mb-1">agent inspector</p>
            <h2 className="display text-[16px] font-semibold text-t1">{AGENT_TITLES[agent] ?? agent}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-[9px] border border-edge text-t3 transition-colors hover:text-t1"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="thin-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {children}

          <section>
            <p className="eyebrow mb-2">event log — {lines.length} real event{lines.length === 1 ? "" : "s"}</p>
            <div className="well thin-scroll max-h-[340px] overflow-y-auto rounded-[12px] px-3.5 py-3 font-mono text-[10.5px] leading-[1.8]">
              {lines.length === 0 ? (
                <p className="text-t3">this agent has not emitted anything yet</p>
              ) : (
                lines.map((e) => (
                  <p
                    key={e.seq}
                    className={cn(
                      "flex gap-2.5",
                      e.kind === "error" ? "text-bad" : e.kind === "success" ? "text-pass" : e.kind === "warn" ? "text-warn" : e.kind === "loop" ? "text-bad" : e.kind === "url" ? "text-brand" : "text-t2",
                    )}
                  >
                    <span className="tnum shrink-0 text-t3/50">{fmtClock(e.at)}</span>
                    <span className="min-w-0 whitespace-pre-wrap break-words">{e.line}</span>
                  </p>
                ))
              )}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

export function AgentMeta({ agent }: { agent: AgentDTO | undefined }) {
  if (!agent) {
    return <p className="text-[12.5px] text-t3">This agent has not been spawned yet. It appears here the moment the orchestrator calls it.</p>;
  }
  return (
    <div className="panel rounded-[12px] px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={agent.status === "done" ? "pass" : agent.status === "failed" ? "bad" : agent.status === "running" ? "brand" : "neutral"}>
          {agent.status}
        </Badge>
        {agent.provider ? <Badge tone="info">{agent.provider}</Badge> : null}
        {agent.model ? <span className="font-mono text-[10px] text-t3">{agent.model}</span> : null}
      </div>
      {agent.detail ? <p className="mt-2.5 text-[12.5px] leading-relaxed text-t2">{agent.detail}</p> : null}
      {agent.error ? <p className="mt-2 font-mono text-[11px] leading-relaxed text-bad">{agent.error}</p> : null}
      <p className="mt-2.5 flex flex-wrap gap-x-4 font-mono text-[10px] text-t3">
        <span className="tnum">tokens {agent.tokens.toLocaleString()}</span>
        <span className="tnum">{agent.endedAt ? fmtDuration(agent.elapsedMs) : "running " + fmtDuration(agent.elapsedMs ?? 0)}</span>
        <span>started {fmtClock(agent.startedAt)}</span>
      </p>
    </div>
  );
}

export function IssueList({ issues }: { issues: IssueDTO[] }) {
  if (issues.length === 0) {
    return <p className="text-[12.5px] text-t3">No defects recorded.</p>;
  }
  return (
    <ul className="space-y-2">
      {issues.map((i) => (
        <li key={i.id} className="rounded-[11px] border border-edge bg-surface px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <Badge tone={i.severity === "critical" ? "bad" : i.severity === "minor" ? "neutral" : "warn"}>{i.severity}</Badge>
            <Badge tone={i.status === "fixed" ? "pass" : "warn"}>{i.status}</Badge>
            <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.12em] text-t3">{i.source} · iter {i.iteration}</span>
          </div>
          <p className="mt-1.5 text-[12.5px] font-medium leading-snug text-t1">{i.title}</p>
          {i.detail ? <p className="mt-1 break-words font-mono text-[10.5px] leading-relaxed text-t3">{i.detail}</p> : null}
        </li>
      ))}
    </ul>
  );
}
