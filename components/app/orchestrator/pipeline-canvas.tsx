"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  FileSearch,
  FileText,
  FlaskConical,
  Hammer,
  Rocket,
  ScanSearch,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { AgentDTO, RunEventDTO, RunFlowDTO } from "@/lib/run-dto";

/* The Agent Orchestration Deck — v3.

   The stage is authored in a fixed 1000×660 "design space" and scaled to fit
   its container with a single transform (ResizeObserver → --oc3-s). Every
   position and size below is therefore exact at any render width: plates can
   never collide, labels can never clip, connectors always meet the pods.

   The agents are little robots with faces — a glass dome, two glowing eyes
   that blink and glance around, a chest core, hovering on a flickering
   thruster. The orchestrator is a bigger ringed station whose eyes follow
   the cursor. State still comes only from real backend artifacts:
     node state   ← agent_runs.status (queued/running/done/failed)
     status line  ← the agent's own latest event line (typewritten as it lands)
     workers      ← labels parsed from the code stage's fan-out events
     loop banner  ← [LOOP] events written by the orchestrator
     meter        ← score values parsed from real test-round events

   All motion is transform/opacity/filter only; prefers-reduced-motion
   collapses the scene to static fades (including the worker orbit). */

export type NodeState = "idle" | "working" | "done" | "failed";

/* ————————————————— design space ————————————————— */

const W = 1000;
const H = 660;

/** the orchestrator station */
const MAIN = { x: 500, y: 126 };
/** links to code/test leave from under the core's plate; the rest from the pod */
const SPAWN_POD = { x: 500, y: 168 };
const SPAWN_UNDER = { x: 500, y: 220 };

/**
 * Stage layout — the six stage bots on a shallow arc under the core, Live QA
 * below. Every label box (118×~56 + 3-line slack) is placed to a fixed rule
 * so boxes can never overlap each other, the core, or the HUD:
 *   outer bots (research/deploy) → box centred under the pod
 *   inner bots (prompt/code/verify/test) → box centred under the pod
 * Core plate sits beside the station, clear of the prompt/verify pods.
 */
const NODES: Record<
  string,
  {
    x: number;
    y: number;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    tag: "below" | "below" | "left" | "right";
  }
> = {
  research: { x: 104, y: 318, label: "Research", icon: FileSearch, tag: "below" },
  prompt: { x: 298, y: 252, label: "Prompt", icon: FileText, tag: "below" },
  code: { x: 500, y: 262, label: "Code", icon: Hammer, tag: "below" },
  verify: { x: 702, y: 252, label: "Verify", icon: ScanSearch, tag: "below" },
  deploy: { x: 896, y: 318, label: "Deploy", icon: Rocket, tag: "below" },
  test: { x: 500, y: 484, label: "Live QA", icon: FlaskConical, tag: "below" },
};

const NODE_ORDER = ["research", "prompt", "code", "verify", "deploy", "test"] as const;

const CHAIN: [string, string][] = [
  ["research", "prompt"],
  ["prompt", "code"],
  ["code", "verify"],
  ["verify", "deploy"],
  ["deploy", "test"],
];

/** worker drone orbit — an ellipse around the Code robot */
const ORBIT = { rx: 100, ry: 24 };

/** state → glow / accent, fed to CSS as --glow / --acc */
const STATE_GLOW: Record<NodeState, string> = {
  idle: "rgba(130,134,190,0.35)",
  working: "rgba(124,122,255,0.9)",
  done: "rgba(53,211,154,0.7)",
  failed: "rgba(255,107,90,0.85)",
};
const STATE_ACC: Record<NodeState, string> = {
  idle: "rgba(158,162,212,0.85)",
  working: "rgba(174,172,255,0.98)",
  done: "rgba(72,226,172,0.98)",
  failed: "rgba(255,124,108,0.98)",
};

const vars = (o: Record<string, string | number>) => o as React.CSSProperties;

/** curved connector path between two points (bows sideways, never vertical-s) */
function curve(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const midX = from.x + dx / 2;
  const midY = from.y + dy / 2;
  const bow = Math.min(52, Math.abs(dx) * 0.16 + 12) * (dx >= 0 ? 1 : -1);
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
      if (t - last > 24) {
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

/** the core's eyes track the cursor — the orchestrator is watching you */
function useEyeTrack(ref: React.RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    const face = el.querySelector<HTMLElement>(".oc3-eyes");
    if (!face) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let tx = 0;
    let ty = 0;
    let cx = 0;
    let cy = 0;
    const step = () => {
      cx += (tx - cx) * 0.14;
      cy += (ty - cy) * 0.14;
      face.style.setProperty("--ex", cx.toFixed(2) + "px");
      face.style.setProperty("--ey", cy.toFixed(2) + "px");
      if (Math.abs(tx - cx) > 0.04 || Math.abs(ty - cy) > 0.04) raf = requestAnimationFrame(step);
      else raf = 0;
    };
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height * 0.42);
      const d = Math.hypot(dx, dy) || 1;
      const m = Math.min(1, d / 260);
      tx = (dx / d) * 2.8 * m;
      ty = (dy / d) * 2 * m;
      if (!raf) raf = requestAnimationFrame(step);
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref, enabled]);
}

/** one worker drone: real label from the fan-out event, real state */
type Worker = { label: string; state: "working" | "done" | "failed" };

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
  const anyRunning = agents.some((a) => a.status === "running");
  const activeLoop = runStatus === "fixing" || (runStatus === "coding" && lastLoop !== null && iteration > 0);

  /* The real worker story: labels parsed from the code stage's own event
     lines — "splitting the build into N worker agent(s): a, b, c" names them
     at spawn; "worker [a] finished/failed" tracks each one's fate. */
  const workers = useMemo<Worker[]>(() => {
    const codeState = nodeStateOfAgentOrEvents(byAgent.get("code"), latestLine.has("code"));
    if (codeState !== "working") return [];
    const order: string[] = [];
    const map = new Map<string, Worker>();
    for (const e of events) {
      if (e.stage !== "code") continue;
      const s = /splitting the build into (\d+) worker agent\(s\): (.+)$/.exec(e.line);
      if (s) {
        for (const label of s[2].split(",").map((x) => x.trim()).filter(Boolean)) {
          if (!map.has(label)) {
            map.set(label, { label, state: "working" });
            order.push(label);
          }
        }
      }
      const f = /worker \[([^\]]+)\] finished/.exec(e.line);
      if (f && map.has(f[1])) map.get(f[1])!.state = "done";
      const fl = /worker \[([^\]]+)\](?: rung)? failed/.exec(e.line);
      if (fl && map.has(fl[1]) && map.get(fl[1])!.state !== "done") map.get(fl[1])!.state = "failed";
    }
    if (order.length === 0) return [];
    return order.slice(0, 5).map((l) => map.get(l)!);
  }, [events, byAgent, latestLine]);

  const coreState: NodeState = runStatus === "done" ? "done" : runStatus === "failed" ? "failed" : "working";

  /* the stage scale: design-space 1000×660 → container width */
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? W;
      el.style.setProperty("--oc3-s", String(Math.min(1.15, w / W)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* worker drone chips — the rAF orbit ticker rides below */
  const chipRefs = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    const count = workers.length;
    if (!count) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const frame = (now: number) => {
      const t = reduced ? 0 : now / 1000;
      for (let i = 0; i < count; i++) {
        const el = chipRefs.current[i];
        if (!el) continue;
        const a = t * 0.55 + (i / count) * Math.PI * 2;
        const x = Math.cos(a) * ORBIT.rx;
        const y = Math.sin(a) * ORBIT.ry;
        const front = Math.sin(a) > -0.08;
        el.style.transform = `translate(-50%,-50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${front ? 1 : 0.8})`;
        el.style.zIndex = front ? "20" : "4";
        el.style.opacity = front ? "1" : "0.55";
      }
      if (!reduced) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [workers]);

  const hudChip =
    runStatus === "done"
      ? { label: "run complete", cls: "border-pass/40 text-pass" }
      : runStatus === "failed"
        ? { label: "run fault", cls: "border-bad/40 text-bad" }
        : anyRunning
          ? { label: "engine live", cls: "border-brand/40 text-brand" }
          : { label: "standby", cls: "border-edge text-t3" };

  return (
    <div className="relative w-full overflow-hidden rounded-[16px] border border-edge bg-well">
      {/* ————————————— the stage ————————————— */}
      <div ref={stageRef} className="oc3-stage relative" style={{ aspectRatio: `${W} / ${H}` }}>
        {/* design space: authored at 1000×660, scaled to the container */}
        <div
          className="absolute left-0 top-0"
          style={{ width: W, height: H, transform: "scale(var(--oc3-s, 1))", transformOrigin: "0 0" }}
        >
          {/* deep-space backdrop: nebula, three parallax star sheets, meteors */}
          <div aria-hidden className="oc3-nebula" />
          <div aria-hidden className="oc3-stars oc3-stars-b" />
          <div aria-hidden className="oc3-stars oc3-stars-a" />
          <div aria-hidden className="oc3-stars oc3-stars-c" />
          <span aria-hidden className="oc3-shoot oc3-shoot-a" />
          <span aria-hidden className="oc3-shoot oc3-shoot-b" />
          {/* perspective grid floor + stage light */}
          <div aria-hidden className="oc3-horizon" />
          <div aria-hidden className="oc3-floor" />
          {anyRunning ? <div aria-hidden className="oc3-scan" /> : null}
          <div aria-hidden className="oc3-vignette" />

          {/* HUD chrome */}
          <div aria-hidden className="oc3-hud oc3-hud-tl">
            <span>orchestration deck</span>
            {anyRunning ? <span className="live-dot h-1 w-1 text-brand" /> : null}
          </div>
          <div aria-hidden className={cn("oc3-hud oc3-hud-tr oc3-hud-chip", hudChip.cls)}>
            {hudChip.label}
          </div>
          <span aria-hidden className="oc3-corner oc3-c-tl" />
          <span aria-hidden className="oc3-corner oc3-c-tr" />
          <span aria-hidden className="oc3-corner oc3-c-bl" />
          <span aria-hidden className="oc3-corner oc3-c-br" />

          {/* connector underlay — same 1000×660 box as the bots, 1:1 coords */}
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="absolute left-0 top-0" aria-hidden>
            <defs>
              <linearGradient id="oc3-edge" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#7c7aff" stopOpacity="0.7" />
                <stop offset="100%" stopColor="#38d9f0" stopOpacity="0.7" />
              </linearGradient>
              <marker id="oc3-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#ff6b5a" />
              </marker>
            </defs>

            {/* spawn links — from the core down to every robot */}
            {Object.entries(NODES).map(([key, n], i) => {
              const state = nodeStateOfAgentOrEvents(byAgent.get(key), latestLine.has(key));
              const lit = state === "working" || state === "done";
              const from = key === "code" || key === "test" ? SPAWN_UNDER : SPAWN_POD;
              const d = curve(from, { x: n.x, y: n.y - 44 });
              return (
                <g key={"spawn-" + key}>
                  <path
                    d={d}
                    fill="none"
                    strokeWidth={1.4}
                    pathLength={lit ? undefined : 1}
                    strokeDasharray={state === "working" ? "5 7" : undefined}
                    className={cn(
                      "transition-[stroke,opacity] duration-700",
                      state === "failed" ? "stroke-bad" : lit ? "stroke-brand" : "stroke-[rgba(148,150,220,0.30)]",
                      !lit && "oc3-draw",
                    )}
                    style={vars({
                      ...(lit ? { opacity: 0.85 } : { "--d": `${560 + i * 70}ms` }),
                      ...(state === "working" ? { animation: "oc3-dash 1.1s linear infinite" } : {}),
                    })}
                  />
                  {/* data comets flow INTO the working node */}
                  {state === "working" ? (
                    <>
                      <circle r={5} fill="#7c7aff" opacity={0.22}>
                        <animateMotion dur="1.6s" repeatCount="indefinite" path={d} />
                      </circle>
                      <circle r={2.6} fill="#a3a1ff">
                        <animateMotion dur="1.6s" repeatCount="indefinite" path={d} />
                      </circle>
                      <circle r={2} fill="#38d9f0" opacity={0.85}>
                        <animateMotion dur="2.1s" begin="0.6s" repeatCount="indefinite" path={d} />
                      </circle>
                    </>
                  ) : null}
                  {state === "done" ? (
                    <path d={d} pathLength={1} fill="none" stroke="#35d39a" strokeWidth={1.8} opacity={0.55} className="oc3-draw-done" />
                  ) : null}
                </g>
              );
            })}

            {/* the flow chain between consecutive agents */}
            {CHAIN.map(([a, b], i) => {
              const na = NODES[a];
              const nb = NODES[b];
              const sa = nodeStateOfAgentOrEvents(byAgent.get(a), latestLine.has(a));
              const sb = nodeStateOfAgentOrEvents(byAgent.get(b), latestLine.has(b));
              const from = { x: na.x + (nb.x >= na.x ? 34 : -34), y: na.y + 6 };
              const to = { x: nb.x + (nb.x >= na.x ? -34 : 34), y: nb.y - 16 };
              const lit = sa === "done" && (sb === "working" || sb === "done");
              return (
                <path
                  key={"chain-" + a + b}
                  d={curve(from, to)}
                  fill="none"
                  strokeWidth={1.3}
                  strokeDasharray="2 6"
                  stroke={lit ? "url(#oc3-edge)" : "rgba(148,150,220,0.22)"}
                  className={cn("transition-opacity duration-500", lit ? "opacity-80" : "opacity-70")}
                  style={vars(lit ? {} : { "--d": `${700 + i * 70}ms` })}
                  pathLength={lit ? undefined : 1}
                />
              );
            })}

            {/* the quality loop — a bold dashed red arrow from test back to code */}
            {activeLoop ? (
              <path
                d={curve({ x: NODES.test.x - 104, y: NODES.test.y - 16 }, { x: NODES.code.x - 104, y: NODES.code.y + 34 })}
                fill="none"
                stroke="#ff6b5a"
                strokeWidth={2.4}
                strokeDasharray="9 7"
                style={{ animation: "oc3-dash 0.9s linear infinite" }}
                markerEnd="url(#oc3-arrow)"
              />
            ) : null}
          </svg>

          {/* worker drone orbit — real fan-out, real labels, real depth */}
          {workers.length > 0 ? (
            <div className="pointer-events-none absolute" style={{ left: NODES.code.x, top: NODES.code.y - 6 }}>
              <span aria-hidden className="oc3-orbit-track" />
              {workers.map((w, i) => {
                const a = (i / workers.length) * Math.PI * 2;
                const front = Math.sin(a) > -0.08;
                return (
                  <div
                    key={w.label + i}
                    ref={(el) => {
                      chipRefs.current[i] = el;
                    }}
                    className="oc3-worker"
                    style={vars({
                      transform: `translate(-50%,-50%) translate(${(Math.cos(a) * ORBIT.rx).toFixed(1)}px, ${(Math.sin(a) * ORBIT.ry).toFixed(1)}px) scale(${front ? 1 : 0.8})`,
                      zIndex: front ? 20 : 4,
                      opacity: front ? 1 : 0.55,
                    })}
                  >
                    <span
                      className={cn(
                        "oc3-worker-chip",
                        w.state === "done" && "oc3-worker-done",
                        w.state === "failed" && "oc3-worker-failed",
                      )}
                    >
                      <Bot className="h-3 w-3 shrink-0" />
                      <span className="max-w-[96px] truncate" title={w.label}>
                        {w.label}
                      </span>
                      {w.state === "working" ? (
                        <span className="live-dot h-1 w-1 shrink-0 text-info" />
                      ) : w.state === "done" ? (
                        <Check className="h-2.5 w-2.5 shrink-0" strokeWidth={3} />
                      ) : (
                        <X className="h-2.5 w-2.5 shrink-0" strokeWidth={3} />
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* the orchestrator station */}
          <MainCore
            state={coreState}
            status={
              latestLine.get("orchestrator") ??
              (runStatus === "done"
                ? "Run complete — every stage green"
                : runStatus === "failed"
                  ? "Run failed — see the report"
                  : "Initializing orchestrator…")
            }
            onClick={() => onSelect("orchestrator")}
          />

          {/* the six stage robots */}
          {NODE_ORDER.map((key, i) => {
            const n = NODES[key];
            const agent = byAgent.get(key);
            const state = nodeStateOfAgentOrEvents(agent, latestLine.has(key));
            const failures = flows.filter((f) => f.status === "fail").length;
            return (
              <BotUnit
                key={key}
                agentKey={key}
                x={n.x}
                y={n.y}
                icon={n.icon}
                label={n.label}
                state={state}
                line={latestLine.get(key) ?? ""}
                badge={key === "test" && failures > 0 ? failures + " failing" : undefined}
                delay={260 + i * 90}
                onClick={() => onSelect(key)}
              />
            );
          })}
        </div>
      </div>

      {/* ————————————— mission readouts ————————————— */}
      {lastLoop ? (
        <div className="relative border-t border-bad/25 bg-[linear-gradient(90deg,rgba(255,107,90,0.12),rgba(255,107,90,0.03))] px-4 py-2.5">
          <div className="flex items-start gap-2.5">
            <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" />
            <p className="min-w-0 whitespace-normal font-mono text-[10.5px] leading-snug text-bad" title={lastLoop.line}>
              {lastLoop.line.replace("[LOOP] ", "").replace("[LOOP CAP] ", "CAP REACHED — ")}
            </p>
          </div>
        </div>
      ) : null}

      <QualityMeter scores={scores} qualityScore={qualityScore} done={runStatus === "done"} measured={measured} />
    </div>
  );
}

/* ————————————————————————— the orchestrator station ————————————————————————— */

function MainCore({ state, status, onClick }: { state: NodeState; status: string; onClick: () => void }) {
  const line = useTypewriter(status, state === "working");
  const ref = useRef<HTMLButtonElement>(null);
  useEyeTrack(ref, true);
  return (
    <button
      type="button"
      ref={ref}
      onClick={onClick}
      className="oc3-unit oc3-core group"
      data-state={state}
      style={vars({ left: MAIN.x, top: MAIN.y, "--d": "80ms", "--glow": STATE_GLOW[state], "--acc": STATE_ACC[state] })}
      aria-label="Main orchestrator"
    >
      <span className="oc3-lift">
        <span className="oc3-bob" style={vars({ "--bob": "5.6s" })}>
          <span className="oc3-halo" />
          <span className="oc3-ring oc3-ring-a" />
          <span className="oc3-ring oc3-ring-b" />
          <span aria-hidden className="oc3-orbit-dot oc3-orbit-dot-a" />
          <span aria-hidden className="oc3-orbit-dot oc3-orbit-dot-b" />
          {/* the station is a big robot too */}
          <span className="oc3-bot oc3-bot-core">
            <span className="oc3-antenna">
              <span className="oc3-beacon" />
            </span>
            <span className="oc3-head">
              <span className="oc3-face">
                <span className="oc3-eyes">
                  <span className="oc3-eye oc3-eye-l" />
                  <span className="oc3-eye oc3-eye-r" />
                </span>
              </span>
            </span>
            <span className="oc3-neck" />
            <span className="oc3-torso oc3-torso-core">
              <span className="oc3-chest" />
            </span>
            <span className="oc3-skirt" />
          </span>
          {state === "working" ? <span className="oc3-reticle oc3-reticle-core" /> : null}
          {state === "done" ? (
            <span className="oc3-seal oc3-seal-core">
              <Check strokeWidth={3} />
            </span>
          ) : null}
        </span>
      </span>
      <span className="oc3-shadow oc3-shadow-core" />
      <span className="oc3-tag oc3-tag-core">
        <span className="oc3-tag-head">
          <span className="oc3-tag-name">main agent</span>
          {state === "working" ? <span className="live-dot h-1 w-1 text-brand" /> : null}
        </span>
        <span className="oc3-tag-line" title={line}>
          {state === "idle" ? "standby" : line}
        </span>
      </span>
    </button>
  );
}

/* ————————————————————————— a stage robot ————————————————————————— */

function BotUnit({
  agentKey,
  x,
  y,
  icon: Icon,
  label,
  state,
  line: rawLine,
  badge,
  delay,
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
  delay: number;
  onClick: () => void;
}) {
  const line = useTypewriter(rawLine.replace(/^-> /, "").replace(/^\$ /, ""), state === "working");
  // deterministic per-robot life: bob period, blink cadence, glance rhythm
  const seed = (x * 7 + y * 13) % 97;
  const bob = (3.8 + (seed % 14) / 10).toFixed(2) + "s";
  const blinkD = (3.4 + (seed % 20) / 10).toFixed(2) + "s";
  const blinkDelay = ((seed % 30) / 10).toFixed(2) + "s";
  const lookD = (7 + (seed % 40) / 10).toFixed(2) + "s";
  const lookDelay = ((seed % 50) / 10).toFixed(2) + "s";
  return (
    <button
      type="button"
      onClick={onClick}
      data-node={agentKey}
      data-state={state}
      aria-label={label + " agent"}
      className="oc3-unit oc3-bot-unit group"
      style={vars({
        left: x,
        top: y,
        "--d": `${delay}ms`,
        "--glow": STATE_GLOW[state],
        "--acc": STATE_ACC[state],
        "--bob": bob,
        "--blink-d": blinkD,
        "--blink-delay": blinkDelay,
        "--look-d": lookD,
        "--look-delay": lookDelay,
      })}
    >
      <span className="oc3-lift">
        <span className="oc3-bob">
          <span className="oc3-halo" />
          {/* the robot */}
          <span className="oc3-bot">
            <span className="oc3-antenna">
              <span className="oc3-beacon" />
            </span>
            <span className="oc3-arm oc3-arm-l" />
            <span className="oc3-arm oc3-arm-r" />
            <span className="oc3-head">
              <span className="oc3-ear oc3-ear-l" />
              <span className="oc3-ear oc3-ear-r" />
              <span className="oc3-face">
                <span className="oc3-eyes">
                  <span className="oc3-eye oc3-eye-l" />
                  <span className="oc3-eye oc3-eye-r" />
                </span>
              </span>
            </span>
            <span className="oc3-neck" />
            <span className="oc3-torso">
              <Icon className="oc3-chest-icon" />
              <span className="oc3-chest" />
            </span>
            <span className="oc3-skirt" />
          </span>
          {state === "working" ? (
            <>
              <span className="oc3-reticle" />
              <span className="oc3-pulse" />
            </>
          ) : null}
          {state === "done" ? (
            <span className="oc3-seal">
              <Check strokeWidth={3} />
            </span>
          ) : null}
          {state === "failed" ? <span className="oc3-alert">!</span> : null}
        </span>
      </span>
      <span className="oc3-shadow" />
      <span className="oc3-tag">
        <span className="oc3-tag-head">
          <span className="oc3-tag-name">{label}</span>
          {state === "working" ? <span className="live-dot h-1 w-1 shrink-0 text-brand" /> : null}
          {badge ? <span className="oc3-tag-badge">{badge}</span> : null}
        </span>
        <span className="oc3-tag-line" title={line}>
          {state === "idle" ? "standby" : line}
        </span>
      </span>
    </button>
  );
}

/* ————————————————————————— the meter ————————————————————————— */

function QualityMeter({
  scores,
  qualityScore,
  done,
  measured,
}: {
  scores: number[];
  qualityScore: number | null;
  done: boolean;
  measured: boolean;
}) {
  const history = scores.length > 0 ? scores : qualityScore != null ? [qualityScore] : [];
  const current = history[history.length - 1] ?? 0;
  const aaa = done && current === 100;

  return (
    <div className="relative border-t border-edge bg-[linear-gradient(180deg,rgba(17,19,40,0.72),rgba(7,8,18,0.94))] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow">quality meter</span>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {history.slice(-6).map((s, i) => (
            <span key={i} className="tnum rounded-full border border-edge bg-surface2 px-1.5 py-0.5 font-mono text-[9px] text-t3">
              {s}
            </span>
          ))}
          <span className={cn("tnum font-mono text-[10.5px]", aaa ? "text-pass" : current > 0 ? "text-warn" : "text-t3")}>
            {aaa ? "AAA QUALITY ✓" : history.length > 0 ? current + "/100" : done ? "not measured" : measured ? current + "/100" : "pending live QA"}
          </span>
        </div>
      </div>
      <div className="mt-2 h-[5px] w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={cn("relative h-full rounded-full bg-gradient-to-r from-brand via-info to-pass transition-[width] duration-1000 ease-out", aaa && "oc3-meter-lock")}
          style={{ width: current + "%" }}
        >
          {history.length > 1 ? (
            <span className="absolute inset-0 overflow-hidden">
              <span className="oc3-sweepbar absolute inset-0" />
            </span>
          ) : null}
        </div>
      </div>
      {history.length > 1 ? (
        <p className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-t3">iterations: {history.map((s) => s + "%").join(" → ")}</p>
      ) : null}
    </div>
  );
}
