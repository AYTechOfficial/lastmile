/* Serialized run state shared between the server page render and the polling
   endpoint. Dates become ISO strings and nothing else does — the client works
   in plain data. */

import type { ResearchBrief } from "./agents/research";
import type { ProductSpec } from "./agents/spec";
import type { MasterBuildPrompt } from "./agents/prompt-engineer";

/** Summary of the last live-QA round, stored with the run. */
export type TestReportDTO = {
  consoleErrors: string[];
  screenshotCount: number;
  flowsTotal: number;
  flowsPassed: number;
  assertions: number;
  score: number;
  browser: string;
};

export type RunDTO = {
  id: string;
  runNumber: number;
  title: string;
  status: string;
  currentStage: string;
  engine: string;
  specVariant: number;
  repoUrl: string | null;
  liveUrl: string | null;
  tokens: number;
  costCents: number;
  error: string | null;
  iterations: number;
  qualityScore: number | null;
  testReport: TestReportDTO | null;
  startedAt: string | null;
  approvedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type IssueDTO = {
  id: string;
  iteration: number;
  source: string;
  severity: string;
  title: string;
  detail: string | null;
  status: string;
  createdAt: string;
};

export type RunEventDTO = {
  seq: number;
  stage: string;
  kind: string;
  line: string;
  at: string;
};

export type RunFlowDTO = {
  position: number;
  name: string;
  assertions: number;
  status: string;
  attempts: number;
  durationMs: number | null;
};

export type AgentDTO = {
  agent: string;
  status: string;
  provider: string | null;
  model: string | null;
  tokens: number;
  elapsedMs: number | null;
  detail: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
};

/** The research brief as the UI consumes it. */
export type ResearchDTO = ResearchBrief;
export type SpecDTO = ProductSpec;

export type RunStateDTO = {
  run: RunDTO;
  events: RunEventDTO[];
  flows: RunFlowDTO[];
  agents: AgentDTO[];
  issues: IssueDTO[];
  research: ResearchDTO | null;
  spec: SpecDTO | null;
  masterPrompt: MasterBuildPrompt | null;
};

/* ————————————————————————— formatting ————————————————————————— */

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "--";
  if (ms < 1000) return ms + "ms";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + "s";
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return rem > 0 ? m + "m " + rem + "s" : m + "m";
}

export function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour12: false });
}

export function fmtRelative(iso: string, now = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return secs + "s ago";
  const m = Math.floor(secs / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : d + "d ago";
}

export function fmtTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(2) + "M";
}

/** Elapsed between a start and (optionally) an end, as clock text. */
export function fmtSpan(fromIso: string, toIso?: string | null): string {
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  return fmtDuration(Math.max(0, to - from));
}

/* ————————————————————————— serializer ————————————————————————— */

type EngineState = {
  run: {
    id: string;
    runNumber: number;
    title: string;
    status: string;
    currentStage: string;
    engine: string;
    specVariant: number;
    repoUrl: string | null;
    liveUrl: string | null;
    tokens: number;
    costCents: number;
    error: string | null;
    iterations: number;
    qualityScore: number | null;
    startedAt: Date | null;
    approvedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    research: unknown;
    spec: unknown;
    masterPrompt: unknown;
    testReport: unknown;
  };
  events: { seq: number; stage: string; kind: string; line: string; at: Date }[];
  flows: { position: number; name: string; assertions: number; status: string; attempts: number; durationMs: number | null }[];
  agents: {
    agent: string;
    status: string;
    provider: string | null;
    model: string | null;
    tokens: number;
    elapsedMs: number | null;
    detail: string | null;
    error: string | null;
    startedAt: Date;
    endedAt: Date | null;
  }[];
  issues: {
    id: string;
    iteration: number;
    source: string;
    severity: string;
    title: string;
    detail: string | null;
    status: string;
    createdAt: Date;
  }[];
};

export function serializeRunState(state: EngineState): RunStateDTO {
  const r = state.run;
  return {
    run: {
      id: r.id,
      runNumber: r.runNumber,
      title: r.title,
      status: r.status,
      currentStage: r.currentStage,
      engine: r.engine,
      specVariant: r.specVariant,
      repoUrl: r.repoUrl,
      liveUrl: r.liveUrl,
      tokens: r.tokens,
      costCents: r.costCents,
      error: r.error,
      iterations: r.iterations,
      qualityScore: r.qualityScore,
      testReport: (r.testReport as TestReportDTO | null) ?? null,
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
      approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    },
    events: state.events.map((e) => ({
      seq: e.seq,
      stage: e.stage,
      kind: e.kind,
      line: e.line,
      at: e.at.toISOString(),
    })),
    flows: state.flows.map((f) => ({
      position: f.position,
      name: f.name,
      assertions: f.assertions,
      status: f.status,
      attempts: f.attempts,
      durationMs: f.durationMs,
    })),
    agents: state.agents.map((a) => ({
      agent: a.agent,
      status: a.status,
      provider: a.provider,
      model: a.model,
      tokens: a.tokens,
      elapsedMs: a.elapsedMs,
      detail: a.detail,
      error: a.error,
      startedAt: a.startedAt.toISOString(),
      endedAt: a.endedAt ? a.endedAt.toISOString() : null,
    })),
    issues: state.issues.map((i) => ({
      id: i.id,
      iteration: i.iteration,
      source: i.source,
      severity: i.severity,
      title: i.title,
      detail: i.detail,
      status: i.status,
      createdAt: i.createdAt.toISOString(),
    })),
    research: (state.run.research as ResearchDTO | null) ?? null,
    spec: (state.run.spec as SpecDTO | null) ?? null,
    masterPrompt: (state.run.masterPrompt as MasterBuildPrompt | null) ?? null,
  };
}
