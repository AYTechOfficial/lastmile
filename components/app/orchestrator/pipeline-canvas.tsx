"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  FlaskConical,
  FileSearch,
  FileText,
  Hammer,
  Rocket,
  ScanSearch,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { AgentDTO, RunEventDTO, RunFlowDTO } from "@/lib/run-dto";

/* The Agent Orchestration Panel — the signature view.

   Every pixel of state here is derived from real backend artifacts:
     node state   ← agent_runs.status (queued/running/done/failed)
     status line  ← the agent's own latest event line (typewritten as it lands)
     particles    ← rendered only while that agent is actually running
     loop banner  ← [LOOP] events written by the orchestrator
     meter        ← score values parsed from real test-round events

   Layout: an SVG underlay draws connectors + flowing particles; nodes are
   positioned HTML cards (glass, shadows, live text) on top. All motion is
   transform/opacity only; prefers-reduced-motion collapses it to fades. */

export type NodeState = "idle" | "spawning" | "working" | "done" | "failed";

const MAIN = { x: 450, y: 64 };
const NODES: Record<string, { x: number; y: number; label: string; icon: React.ComponentType<{ className?: string }> }> = {
  research: { x: 110, y: 190, label: "Research", icon: FileSearch },
  prompt: { x: 280, y: 150, label: "Prompt", icon: FileText },
  code: { x: 450, y: 216, label: "Code", icon: Hammer },
  verify: { x: 620, y: 150, label: "Verify", icon: ScanSearch },
  deploy: { x: 790, y: 190, label: "Deploy", icon: Rocket },
  test: { x: 450, y: 388, label: "Live QA", icon: FlaskConical },
};

/* The worker ring: small agents the Code node spawns on the first pass. They
   appear only while code is working — the fan-out is real, driven by the same
   worker events the backend emits (`worker [label] finished — n file(s)`). */
const WORKERS = [
  { x: 285, y: 300, label: "W1" },
  { x: 368, y: 322, label: "W2" },
  { x: 450, y: 330, label: "W3" },
  { x: 532, y: 322, label: "W4" },
  { x: 615, y: 300, label: "W5" },
];

const W = 900;
const H = 470;

/** curved connector path between two points */
function curve(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const midX = from.x + dx / 2;
  const midY = from.y + dy / 2;
  const bow = Math.min(46, Math.abs(dx) * 0.18 + 12) * (dx >= 0 ? 1 : -1);
  return `M ${from.x} ${from.y} C ${midX + bow} ${midY - 26}, ${midX + bow} ${midY + 26}, ${to.x} ${to.y}`;
}

function nodeStateOf(agent: AgentDTO | undefined): NodeState {
  if (!agent) return "idle";
  if (agent.status === "running") return "working";
  if (agent.status === "done") return "done";
  if (agent.status === "failed") return "failed";
  return "idle";
}

/** Legacy runs (old engine) have real events but no agent rows — a node with
    event lines for its stage did run, so it renders done, never "waiting". */
function nodeStateOfAgentOrEvents(agent: AgentDTO | undefined, hasEvents: boolean): NodeState {
  const fromAgent = nodeStateOf(agent);
  if (fromAgent !== "idle") return fromAgent;
  return hasEvents ? "done" : "idle";
}

/** typewriter for the live status line — text is real, the reveal is cosmetic.
    The animation starts from an empty string in the state initializer, so the
    effect only ever sets state from async callbacks (no sync setState). */
function useTypewriter(text: string, enabled: boolean) {
  const [shown, setShown] = useState(() => (enabled ? "" : text));
  const raf = useRef<number>(0);
  useEffect(() => {
    if (!enabled || !text) return;
    let i = 0;
    let last = -1e9;
    let cancelled = false;
    const step = (t: number) => {
      if (cancelled) return;
      if (t - last > 26) {
        i = Math.min(text.length, i + 2);
        last = t;
        setShown(text.slice(0, i));
      }
      if (i < text.length) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf.current);
    };
  }, [text, enabled]);
  // once the animation is done (or disabled) always show the full text
  return enabled && shown.length < text.length ? shown : text;
}

export function PipelineCanvas({
  agents,
  events,
  flows,
  runStatus,
  iteration,
  qualityScore,
  onSelect,
}: {
  agents: AgentDTO[];
  events: RunEventDTO[];
  flows: RunFlowDTO[];
  runStatus: string;
  iteration: number;
  qualityScore: number | null;
  onSelect: (agent: string) => void;
}) {
  const byAgent = useMemo(() => {
    const map = new Map<string, AgentDTO>();
    for (const a of agents) map.set(a.agent, a);
    return map;
  }, [agents]);

  /** the newest line each agent has emitted — the honest status text */
  const latestLine = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of events) {
      if (e.kind === "loop" || e.kind === "flow") continue;
      map.set(e.stage, e.line.replace(/^-> /, "").replace(/^\$ /, ""));
    }
    return map;
  }, [events]);

  const loopEvents = useMemo(() => events.filter((e) => e.kind === "loop"), [events]);
  const lastLoop = loopEvents[loopEvents.length - 1] ?? null;

  const scores = useMemo(() => {
    const out: number[] = [];
    for (const e of events) {
      if (e.stage === "test" && /score (\d+)\/100/.test(e.line)) {
        const m = /score (\d+)\/100/.exec(e.line);
        if (m) out.push(Number(m[1]));
      }
    }
    return out;
  }, [events]);

  const measured = scores.length > 0 || qualityScore != null;

  const activeLoop = runStatus === "fixing" || (runStatus === "coding" && lastLoop !== null && iteration > 0);

  /* The real worker story: labels parsed from the code stage's own event
     lines. A worker that emitted "finished" renders done; one still absent
     while code runs renders working; nothing renders when code is idle. */
  const workers = useMemo(() => {
    const codeState = nodeStateOfAgentOrEvents(byAgent.get("code"), latestLine.has("code"));
    if (codeState !== "working") return [];
    const finished = new Set<string>();
    let spawned = 0;
    for (const e of events) {
      if (e.stage !== "code") continue;
      const m = /splitting the build into (\d+) worker/.exec(e.line);
      if (m) spawned = Number(m[1]);
      const f = /worker \[([^\]]+)\] finished/.exec(e.line);
      if (f) finished.add(f[1]);
    }
    if (spawned === 0) return [];
    return WORKERS.slice(0, Math.min(spawned, WORKERS.length)).map((w, i) => ({
      ...w,
      state: (i < finished.size ? "done" : "working") as NodeState,
    }));
  }, [events, byAgent, latestLine]);

  return (
    <div className="relative w-full overflow-hidden rounded-[16px] border border-edge bg-well">
      <div className="relative" style={{ aspectRatio: `${W} / ${H}`, containerType: "inline-size" }}>
        {/* ambient field — grid, drifting stars, nebula wash, radar scan */}
        <div aria-hidden className="rule-grid pointer-events-none absolute inset-0 opacity-30" />
        <div aria-hidden className="canvas-nebula" />
        <div aria-hidden className="canvas-stars-far" />
        <div aria-hidden className="canvas-stars" />
        {agents.some((a) => a.status === "running") ? <div aria-hidden className="canvas-scan" /> : null}

        {/* connector underlay — SAME box as the node layer, so SVG coordinates
            map 1:1 onto the card centers (stretching it over the meter below
            was displacing every curve) */}
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" aria-hidden preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="edge-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#7c7aff" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#38d9f0" stopOpacity="0.5" />
          </linearGradient>
        </defs>

        {/* spawn links from the core */}
        {Object.entries(NODES).map(([key, n]) => {
          const state = nodeStateOfAgentOrEvents(byAgent.get(key), latestLine.has(key));
          const d = curve(MAIN, n);
          const lit = state === "working" || state === "done";
          return (
            <g key={"spawn-" + key}>
              <path
                d={d}
                fill="none"
                strokeWidth={1.4}
                className={cn(
                  "transition-[stroke,opacity] duration-500",
                  state === "failed" ? "stroke-bad" : lit ? "stroke-brand" : "stroke-edge2",
                  state === "idle" ? "opacity-30" : "opacity-80",
                )}
                strokeDasharray={state === "working" ? "5 6" : undefined}
                style={state === "working" ? { animation: "dash-flow 1.2s linear infinite" } : undefined}
              />
              {/* particles flow INTO the working node */}
              {state === "working" ? (
                <>
                  <circle r={2.6} fill="#7c7aff">
                    <animateMotion dur="1.5s" repeatCount="indefinite" path={d} />
                  </circle>
                  <circle r={1.8} fill="#38d9f0">
                    <animateMotion dur="1.9s" begin="0.5s" repeatCount="indefinite" path={d} />
                  </circle>
                </>
              ) : null}
              {state === "done" ? <path d={d} fill="none" stroke="#35d39a" strokeWidth={2} opacity={0.55} className="sweep-once" /> : null}
            </g>
          );
        })}

        {/* the flow chain between consecutive agents */}
        {[
          ["research", "prompt"],
          ["prompt", "code"],
          ["code", "verify"],
          ["verify", "deploy"],
          ["deploy", "test"],
        ].map(([a, b]) => {
          const na = NODES[a];
          const nb = NODES[b];
          const sa = nodeStateOfAgentOrEvents(byAgent.get(a), latestLine.has(a));
          const sb = nodeStateOfAgentOrEvents(byAgent.get(b), latestLine.has(b));
          const from = { x: na.x, y: na.y + 26 };
          const to = { x: nb.x, y: nb.y - 30 };
          const lit = sa === "done" && (sb === "working" || sb === "done");
          return (
            <path
              key={"chain-" + a + b}
              d={curve(from, to)}
              fill="none"
              strokeWidth={1.2}
              className={cn("transition-opacity duration-500", lit ? "stroke-info opacity-70" : "stroke-edge opacity-30")}
              strokeDasharray="2 5"
            />
          );
        })}

        {/* the quality loop — a bold dashed red arrow from test back to code */}
        {activeLoop ? (
          <g>
            <path
              d={curve({ x: NODES.test.x - 44, y: NODES.test.y - 12 }, { x: NODES.code.x - 44, y: NODES.code.y + 26 })}
              fill="none"
              stroke="#ff6b5a"
              strokeWidth={2.4}
              strokeDasharray="9 7"
              style={{ animation: "dash-flow 0.9s linear infinite" }}
              markerEnd="url(#loop-arrow)"
            />
            <marker id="loop-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#ff6b5a" />
            </marker>
          </g>
        ) : null}
      </svg>

      {/* main agent */}
      <MainNode
        state={runStatus === "done" ? "done" : runStatus === "failed" ? "failed" : "working"}
        status={
          latestLine.get("orchestrator") ??
          (runStatus === "done" ? "Run complete — every stage green" : runStatus === "failed" ? "Run failed — see the report" : "Initializing orchestrator…")
        }
        onClick={() => onSelect("orchestrator")}
      />

      {/* worker ring — real fan-out under the Code node */}
      {workers.map((w, i) => {
        const from = { x: NODES.code.x, y: NODES.code.y + 24 };
        const to = { x: w.x, y: w.y - 18 };
        const d = curve(from, to);
        return (
          <g key={"worker-g-" + i}>
            <path
              d={d}
              fill="none"
              strokeWidth={1.2}
              className={w.state === "done" ? "stroke-pass" : "stroke-brand"}
              opacity={w.state === "done" ? 0.6 : 0.85}
              strokeDasharray={w.state === "working" ? "4 5" : undefined}
              style={w.state === "working" ? { animation: "dash-flow 1s linear infinite" } : undefined}
            />
            {w.state === "working" ? (
              <circle r={2.2} fill="#38d9f0">
                <animateMotion dur="1.1s" repeatCount="indefinite" path={d} />
              </circle>
            ) : null}
          </g>
        );
      })}
      {workers.map((w, i) => (
        <div
          key={"worker-" + i}
          className={cn(
            "absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-[9px] border px-1.5 py-1 backdrop-blur-md transition-all duration-300",
            w.state === "done" ? "border-pass/40 bg-pass/10" : "border-brand/50 bg-surface/90 node-glow",
          )}
          style={{ left: (w.x / W) * 100 + "%", top: (w.y / H) * 100 + "%" }}
        >
          <span className="flex items-center gap-1">
            <Hammer className={cn("h-2.5 w-2.5", w.state === "done" ? "text-pass" : "text-brand")} />
            <span className="font-mono text-[8px] tracking-[0.1em] text-t2">{w.label}</span>
            {w.state === "working" ? <span className="live-dot h-1 w-1 text-brand" /> : <Check className="h-2.5 w-2.5 text-pass" strokeWidth={3} />}
          </span>
        </div>
      ))}

      {/* sub-agents */}
      {Object.entries(NODES).map(([key, n]) => {
        const agent = byAgent.get(key);
        const state = nodeStateOfAgentOrEvents(agent, latestLine.has(key));
        const failures = flows.filter((f) => f.status === "fail").length;
        return (
          <NodeCard
            key={key}
            agentKey={key}
            x={n.x}
            y={n.y}
            icon={n.icon}
            label={n.label}
            state={state}
            line={latestLine.get(key) ?? ""}
            badge={key === "test" && failures > 0 ? failures + " failing" : undefined}
            pulse={workers.some((w) => w.state === "working") && key === "code"}
            onClick={() => onSelect(key)}
          />
        );
      })}

      {/* the quality-loop banner */}
      {lastLoop ? (
        <div className="rise absolute inset-x-3 bottom-2 z-10">
          <div className="flex items-center gap-2.5 rounded-[11px] border border-bad/40 bg-bad/10 px-3.5 py-2 backdrop-blur-md">
            <X className="h-3.5 w-3.5 shrink-0 text-bad" />
            <p className="min-w-0 truncate font-mono text-[11px] text-bad">{lastLoop.line.replace("[LOOP] ", "").replace("[LOOP CAP] ", "CAP REACHED — ")}</p>
          </div>
        </div>
      ) : null}
      </div>

      {/* the quality meter */}
      <QualityMeter scores={scores} qualityScore={qualityScore} done={runStatus === "done"} measured={measured} />
    </div>
  );
}

/* ————————————————————————— nodes ————————————————————————— */

function MainNode({ state, status, onClick }: { state: NodeState; status: string; onClick: () => void }) {
  const line = useTypewriter(status, state === "working");
  return (
    <button
      type="button"
      onClick={onClick}
      className="group absolute z-10 -translate-x-1/2 -translate-y-1/2 focus-visible:outline-2"
      style={{ left: (MAIN.x / W) * 100 + "%", top: (MAIN.y / H) * 100 + "%" }}
      aria-label="Main orchestrator"
    >
      <span className="relative flex h-[74px] w-[74px] items-center justify-center">
        {/* layered rings */}
        <span className={cn("absolute inset-0 rounded-full border border-brand/25", state === "working" && "core-breathe")} />
        <span className="absolute inset-[7px] rounded-full border border-brand2/30" />
        <span
          className={cn(
            "absolute inset-[14px] rounded-full border bg-gradient-to-br from-brand/25 to-info/10 backdrop-blur-sm transition-colors",
            state === "done" && "border-pass/60 from-pass/25",
            state === "failed" && "border-bad/60 from-bad/25",
          )}
        />
        {state === "working" ? (
          <span className="absolute inset-0 rounded-full border-t-2 border-brand/70 [animation:spin_2.4s_linear_infinite]" />
        ) : null}
        <Sparkles className={cn("relative h-6 w-6 text-brand", state === "done" && "text-pass", state === "failed" && "text-bad")} />
      </span>
      <span className="mt-1.5 block text-center">
        <span className="block font-mono text-[9px] uppercase tracking-[0.18em] text-t2">main agent</span>
        <span className="mt-0.5 block max-w-[190px] truncate font-mono text-[9.5px] text-t3" title={line}>
          {line}
        </span>
      </span>
    </button>
  );
}

function NodeCard({
  agentKey,
  x,
  y,
  icon: Icon,
  label,
  state,
  line: rawLine,
  badge,
  pulse,
  onClick,
}: {
  agentKey: string;
  x: number;
  y: number;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  state: NodeState;
  line: string;
  badge?: string;
  pulse?: boolean;
  onClick: () => void;
}) {
  /* a node that mounts while its agent is already working just spawned —
     play the spawn animation once; nodes that mount done (page reload)
     render statically */
  const [spawnAnim, setSpawnAnim] = useState(state === "working");
  useEffect(() => {
    if (!spawnAnim) return;
    const t = setTimeout(() => setSpawnAnim(false), 750);
    return () => clearTimeout(t);
  }, [spawnAnim]);

  const line = useTypewriter(rawLine.replace(/^-> /, "").replace(/^\$ /, ""), state === "working");
  const display: NodeState = spawnAnim ? "spawning" : state;
  return (
    <button
      type="button"
      onClick={onClick}
      data-node={agentKey}
      aria-label={label + " agent"}
      className={cn(
        "absolute z-10 w-[clamp(96px,14.2cqw,128px)] -translate-x-1/2 -translate-y-1/2 rounded-[13px] border px-2.5 py-2 text-left backdrop-blur-md transition-all duration-300",
        display === "idle" && "border-edge bg-surface/70 opacity-35",
        display === "spawning" && "spawn-pop border-brand/50 bg-surface shadow-[0_0_36px_-6px_rgba(124,122,255,0.6)]",
        (display === "working" || display === "done" || display === "failed") && "border-brand/40 bg-surface/90",
        display === "working" && !pulse && "node-glow",
        display === "working" && pulse && "worker-pulse",
        display === "done" && "border-pass/40",
        display === "failed" && "node-shake border-bad/50",
      )}
      style={{ left: (x / W) * 100 + "%", top: (y / H) * 100 + "%" }}
    >
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border",
            display === "done" ? "border-pass/40 bg-pass/10 text-pass" : display === "failed" ? "border-bad/40 bg-bad/10 text-bad" : display === "working" || display === "spawning" ? "border-brand/40 bg-brand/10 text-brand" : "border-edge bg-surface2 text-t3",
          )}
        >
          {display === "done" ? <Check className="h-3 w-3" strokeWidth={3} /> : <Icon className="h-3 w-3" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate font-mono text-[9px] uppercase tracking-[0.16em]", display === "idle" ? "text-t3" : "text-t1")}>{label}</span>
        </span>
        {display === "working" ? <span className="live-dot h-1.5 w-1.5 shrink-0 text-brand" /> : null}
        {badge ? <span className="shrink-0 rounded-full border border-bad/30 bg-bad/10 px-1 font-mono text-[8px] text-bad">{badge}</span> : null}
      </span>
      <span className="mt-1 line-clamp-2 min-h-[22px] font-mono text-[9px] leading-[1.5] text-t3" title={line}>
        {display === "idle" ? "waiting" : line}
      </span>
    </button>
  );
}

/* ————————————————————————— the meter ————————————————————————— */

function QualityMeter({ scores, qualityScore, done, measured }: { scores: number[]; qualityScore: number | null; done: boolean; measured: boolean }) {
  const history = scores.length > 0 ? scores : qualityScore != null ? [qualityScore] : [];
  const current = history[history.length - 1] ?? 0;
  const aaa = done && current === 100;

  return (
    <div className="relative border-t border-edge px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow">quality meter</span>
        <span className={cn("tnum font-mono text-[10.5px]", aaa ? "text-pass" : current > 0 ? "text-warn" : "text-t3")}>
          {aaa
            ? "AAA QUALITY ACHIEVED ✓"
            : history.length > 0
              ? current + "/100"
              : done
                ? "not measured"
                : measured
                  ? current + "/100"
                  : "pending live QA"}
        </span>
      </div>
      <div className="mt-2 h-[5px] w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={cn(
            "relative h-full rounded-full bg-gradient-to-r from-brand via-info to-pass transition-[width] duration-1000 ease-out",
            aaa && "meter-lock",
          )}
          style={{ width: current + "%" }}
        >
          {history.length > 1 ? (
            <span className="absolute inset-0 overflow-hidden">
              <span className="sweep absolute inset-0" />
            </span>
          ) : null}
        </div>
      </div>
      {history.length > 1 ? (
        <p className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-t3">
          iterations: {history.map((s) => s + "%").join(" → ")}
        </p>
      ) : null}
    </div>
  );
}
