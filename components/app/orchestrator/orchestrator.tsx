"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Code2, LayoutPanelLeft, Monitor, ScrollText } from "lucide-react";
import { cn } from "@/lib/cn";
import type { RunStateDTO } from "@/lib/run-dto";
import { statusMeta } from "@/components/app/status";
import { ActivityLog } from "@/components/app/activity-log";
import { ResearchBrief } from "@/components/app/research-brief";
import { AgentDrawer, AgentMeta, IssueList } from "./agent-drawer";
import { CodeViewer } from "./code-viewer";
import { CompletionTakeover, FailureState } from "./completion";
import { LivePreview } from "./live-preview";
import { PipelineCanvas } from "./pipeline-canvas";

/* The Orchestrator Panel — everything the build view is made of.

   Live data: subscribes to the SSE stream (each frame is the full serialized
   run state, straight from the database) and falls back to interval polling
   if the stream never opens. A browser notification fires when the run
   finishes while the tab is in the background, and status changes are
   announced through an aria-live region. */

type Tab = "pipeline" | "preview" | "code" | "report";

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "pipeline", label: "Pipeline", icon: LayoutPanelLeft },
  { id: "preview", label: "Live Preview", icon: Monitor },
  { id: "code", label: "Code", icon: Code2 },
  { id: "report", label: "Full Report", icon: ScrollText },
];

export function Orchestrator({ initial, onRefreshChrome }: { initial: RunStateDTO; onRefreshChrome?: () => void }) {
  const [state, setState] = useState<RunStateDTO>(initial);
  const [tab, setTab] = useState<Tab>("pipeline");
  const [drawer, setDrawer] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const lastStatus = useRef(initial.run.status);
  const viaStream = useRef(false);

  const runId = initial.run.id;
  const run = state.run;
  const meta = statusMeta(run.status);

  /* live subscription */
  useEffect(() => {
    if (run.status === "done" || run.status === "failed") return;
    let stopped = false;
    let poller: ReturnType<typeof setInterval> | null = null;
    let es: EventSource | null = null;

    const apply = (next: RunStateDTO) => {
      if (stopped) return;
      setState(next);
    };

    const startPolling = () => {
      if (poller || stopped) return;
      poller = setInterval(async () => {
        try {
          const res = await fetch("/api/runs/" + runId + "/state", { cache: "no-store" });
          if (res.ok) apply((await res.json()) as RunStateDTO);
        } catch {
          /* next tick retries */
        }
      }, 1500);
    };

    try {
      es = new EventSource("/api/runs/" + runId + "/stream");
      es.onopen = () => {
        viaStream.current = true;
      };
      es.onmessage = (ev) => {
        try {
          apply(JSON.parse(ev.data) as RunStateDTO);
        } catch {
          /* malformed frame — ignore */
        }
      };
      es.addEventListener("end", () => {
        es?.close();
        startPolling(); // one final poll picks up the terminal frame
      });
      es.onerror = () => {
        // stream broke — fall back to polling and keep the view alive
        es?.close();
        es = null;
        startPolling();
      };
    } catch {
      startPolling();
    }

    return () => {
      stopped = true;
      es?.close();
      if (poller) clearInterval(poller);
    };
  }, [runId, run.status]);

  /* chrome refresh + announcements + notifications on status change */
  useEffect(() => {
    if (lastStatus.current === run.status) return;
    const from = lastStatus.current;
    lastStatus.current = run.status;
    onRefreshChrome?.();
    setAnnouncement("Run is now " + meta.label);

    if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
      if (run.status === "done") new Notification("LastMile — your product shipped", { body: run.liveUrl ?? "" });
      if (run.status === "failed") new Notification("LastMile — the pipeline stopped", { body: run.error ?? "" });
    }
    if (from === "awaiting_approval") setDismissed(false);
  }, [run.status, run.liveUrl, run.error, meta.label, onRefreshChrome]);

  /* ask once, politely, when a run is in flight */
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default" && meta.live) {
      void Notification.requestPermission().catch(() => undefined);
    }
  }, [meta.live]);

  const issues = state.issues;
  const openIssues = useMemo(() => issues.filter((i) => i.status === "open"), [issues]);
  const takeover = run.status === "done" && run.liveUrl && !dismissed;

  return (
    <div className="space-y-4" aria-live="polite">
      <span className="sr-only" role="status">{announcement}</span>

      {takeover ? (
        <CompletionTakeover
          title={run.title}
          liveUrl={run.liveUrl!}
          repoUrl={run.repoUrl}
          runId={run.id}
          qualityScore={run.qualityScore}
          iterations={run.iterations}
          onDismiss={() => setDismissed(true)}
        />
      ) : null}

      {run.status === "failed" ? (
        <FailureState error={run.error} issues={issues} runId={run.id} liveUrl={run.liveUrl} />
      ) : null}

      {/* tabs */}
      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Build view sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex h-9 items-center gap-2 rounded-[10px] border px-3.5 text-[12.5px] transition-all",
              tab === t.id
                ? "border-brand/45 bg-[linear-gradient(180deg,rgba(124,122,255,0.18),rgba(124,122,255,0.06))] text-brand shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),0_4px_16px_-8px_rgba(124,122,255,0.55)]"
                : "border-edge bg-surface/80 text-t3 hover:text-t1",
            )}
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
            {t.id === "code" && state.events.some((e) => e.stage === "code") ? <span className="h-1 w-1 rounded-full bg-brand" /> : null}
          </button>
        ))}
        {openIssues.length > 0 ? (
          <span className="ml-auto rounded-full border border-bad/30 bg-bad/10 px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-bad">
            {openIssues.length} open defect{openIssues.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {tab === "pipeline" ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
          <div className="min-w-0 space-y-4">
            <PipelineCanvas
              agents={state.agents}
              events={state.events}
              flows={state.flows}
              runStatus={run.status}
              iteration={run.iterations}
              qualityScore={run.qualityScore}
              onSelect={setDrawer}
            />
          </div>
          <div className="min-w-0">
            <ActivityLog events={state.events} runNumber={run.runNumber} live={meta.live} />
          </div>
        </div>
      ) : null}

      {tab === "preview" ? <LivePreview liveUrl={run.liveUrl} /> : null}
      {tab === "code" ? <CodeViewer runId={run.id} live={meta.live} /> : null}
      {tab === "report" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {state.research ? <ResearchBrief brief={state.research} /> : null}
          {state.masterPrompt ? <MasterPromptCard prompt={state.masterPrompt} /> : null}
          <div className="lg:col-span-2">
            <div className="panel rounded-[14px] p-4">
              <p className="eyebrow eyebrow-strong mb-3">defect ledger — {issues.length} recorded</p>
              <IssueList issues={issues} />
            </div>
          </div>
        </div>
      ) : null}

      {drawer ? (
        <AgentDrawer agent={drawer} events={state.events} onClose={() => setDrawer(null)}>
          <AgentMeta agent={state.agents.find((a) => a.agent === drawer)} />
          {drawer === "test" ? <IssueList issues={issues} /> : null}
          {drawer === "prompt" && state.masterPrompt ? (
            <div className="well max-h-[260px] overflow-y-auto whitespace-pre-wrap rounded-[12px] px-4 py-3 font-mono text-[10.5px] leading-relaxed text-t2">
              {state.masterPrompt.instructions.slice(0, 4000)}
            </div>
          ) : null}
          {drawer === "deploy" && run.liveUrl ? (
            <a href={run.liveUrl} target="_blank" rel="noreferrer" className="block rounded-[11px] border border-pass/30 bg-pass/[0.07] px-3.5 py-2.5 font-mono text-[12px] text-pass">
              {run.liveUrl}
            </a>
          ) : null}
          {drawer === "research" && state.research ? (
            <div className="space-y-1.5">
              {state.research.sources.slice(0, 10).map((s) => (
                <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="block truncate rounded-[8px] border border-edge bg-surface px-3 py-1.5 font-mono text-[10.5px] text-info hover:border-edge2">
                  {s.host} — {s.title}
                </a>
              ))}
            </div>
          ) : null}
        </AgentDrawer>
      ) : null}
    </div>
  );
}

function MasterPromptCard({ prompt }: { prompt: NonNullable<RunStateDTO["masterPrompt"]> }) {
  return (
    <div className="panel rounded-[14px] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="eyebrow eyebrow-strong">master build prompt</p>
        <span className="font-mono text-[10px] text-t3">
          {prompt.features.length} features · {prompt.superiority.length} edges · {prompt.model ?? "assembled from spec"}
        </span>
      </div>
      <p className="display mt-2 text-[15px] font-semibold text-t1">{prompt.productName}</p>
      <p className="mt-0.5 text-[12.5px] leading-relaxed text-t2">{prompt.tagline}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {prompt.stack.map((s) => (
          <span key={s} className="rounded-full border border-edge bg-surface2 px-2 py-0.5 font-mono text-[9.5px] text-t2">
            {s}
          </span>
        ))}
      </div>
      <details className="group mt-3">
        <summary className="cursor-pointer list-none font-mono text-[10px] uppercase tracking-[0.14em] text-brand">read the full contract</summary>
        <div className="well thin-scroll mt-2 max-h-[300px] overflow-y-auto whitespace-pre-wrap rounded-[11px] px-3.5 py-3 font-mono text-[10px] leading-relaxed text-t2">
          {prompt.instructions}
        </div>
      </details>
    </div>
  );
}
