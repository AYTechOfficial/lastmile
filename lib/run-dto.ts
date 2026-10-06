/* The serialized run state shared between the server render and the polling
   endpoint. Dates become ISO strings; nothing else changes, so the client works
   with plain data.

   This module imports `./domain` and nothing else. That matters: the dashboard
   renders run state, and it must not pull the agent pipeline into its module
   graph. The previous build's run page imported a browser driver by accident
   through exactly this kind of chain and died on a host that could not resolve
   it. */

import type {
  AgentEventKind,
  ConformanceReport,
  MasterBuildPrompt,
  ProductSpec,
  ResearchBrief,
  Severity,
  TestReport,
  TestReportDTO,
} from "./domain";

export type { TestReportDTO };

export type RunDTO = {
  id: string;
  runNumber: number;
  sentence: string;
  title: string;
  slug: string;
  status: string;
  currentStage: string;
  planId: string;
  specVariant: number;
  repoUrl: string | null;
  repoOwner: string | null;
  repoName: string | null;
  commitSha: string | null;
  liveUrl: string | null;
  deployId: string | null;
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
  severity: Severity;
  title: string;
  detail: string | null;
  files: string[];
  status: string;
  createdAt: string;
};

export type RunEventDTO = {
  seq: number;
  stage: string;
  kind: AgentEventKind | string;
  line: string;
  at: string;
};

export type RunFlowDTO = {
  position: number;
  name: string;
  intent: string | null;
  assertions: number;
  status: string;
  attempts: number;
  durationMs: number | null;
  failure: string | null;
};

export type AgentDTO = {
  agent: string;
  iteration: number;
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
  conformance: ConformanceReport | null;
  testReport: TestReport | null;
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
    sentence: string;
    title: string;
    slug: string;
    status: string;
    currentStage: string;
    planId: string;
    specVariant: number;
    repoUrl: string | null;
    repoOwner: string | null;
    repoName: string | null;
    commitSha: string | null;
    liveUrl: string | null;
    deployId: string | null;
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
    conformance: unknown;
    testReport: unknown;
  };
  events: { seq: number; stage: string; kind: string; line: string; at: Date }[];
  flows: {
    position: number;
    name: string;
    intent: string | null;
    assertions: number;
    status: string;
    attempts: number;
    durationMs: number | null;
    failure: string | null;
  }[];
  agents: {
    agent: string;
    iteration: number;
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
    files: unknown;
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
      sentence: r.sentence,
      title: r.title,
      slug: r.slug,
      status: r.status,
      currentStage: r.currentStage,
      planId: r.planId,
      specVariant: r.specVariant,
      repoUrl: r.repoUrl,
      repoOwner: r.repoOwner,
      repoName: r.repoName,
      commitSha: r.commitSha,
      liveUrl: r.liveUrl,
      deployId: r.deployId,
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
      intent: f.intent,
      assertions: f.assertions,
      status: f.status,
      attempts: f.attempts,
      durationMs: f.durationMs,
      failure: f.failure,
    })),
    agents: state.agents.map((a) => ({
      agent: a.agent,
      iteration: a.iteration,
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
      severity: i.severity as Severity,
      title: i.title,
      detail: i.detail,
      files: (i.files as string[] | null) ?? [],
      status: i.status,
      createdAt: i.createdAt.toISOString(),
    })),
    research: (r.research as ResearchDTO | null) ?? null,
    spec: (r.spec as SpecDTO | null) ?? null,
    masterPrompt: (r.masterPrompt as MasterBuildPrompt | null) ?? null,
    conformance: (r.conformance as ConformanceReport | null) ?? null,
    testReport: (r.testReport as TestReport | null) ?? null,
  };
}
