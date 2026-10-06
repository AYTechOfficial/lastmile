import { AlertCircle, Bot, Check, ExternalLink, Loader2, Package } from "lucide-react";
import { cn } from "@/lib/cn";
import { Panel } from "@/components/kit";
import { GithubIcon } from "@/components/github-icon";
import { fmtDuration, fmtRelative, fmtTokens, type AgentDTO, type RunDTO } from "@/lib/run-dto";

/* The right rail: what the run is doing, what it has produced, and what it
   cost. Every number here comes from a row in the database. */

export function Telemetry({ run, agents, now = 0 }: { run: RunDTO; agents: AgentDTO[]; now?: number }) {
  const started = run.startedAt ?? run.createdAt;
  const elapsed = elapsedOf(started, run.completedAt, now);

  return (
    <div className="space-y-4">
      <Panel className="overflow-hidden">
        <header className="border-b border-edge px-4 py-2.5">
          <span className="eyebrow eyebrow-strong">Run</span>
        </header>
        <div className="divide-y divide-edge/70 px-4">
          <Row label="Started" value={fmtRelative(started, now || undefined)} />
          <Row label="Elapsed" value={elapsed} />
          {/* Which plan governed this run — and therefore which model tier it
              was allowed to route to. Recorded on the run, so an old run still
              reads correctly after the policy changes. */}
          <Row label="Plan" value={run.planId === "pro" ? "Pro" : "Free"} />
          <Row label="Spec" value={"v" + run.specVariant} />
          <Row label="Tokens" value={fmtTokens(run.tokens)} />
          <Row
            label="Model spend"
            value={run.costCents > 0 ? "$" + (run.costCents / 100).toFixed(2) : "$0.00"}
            tone={run.costCents > 0 ? "neutral" : "pass"}
            hint={run.costCents > 0 ? undefined : "free tier"}
          />
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <header className="border-b border-edge px-4 py-2.5">
          <span className="eyebrow eyebrow-strong">Agents</span>
        </header>
        <div className="space-y-2 p-3">
          {agents.length === 0 ? (
            <p className="px-1 py-2 text-[12px] text-t3">No agent has reported yet.</p>
          ) : (
            agents.map((a) => <AgentRow key={a.agent} agent={a} />)
          )}
        </div>
      </Panel>

      {run.repoUrl || run.liveUrl ? (
        <Panel className="overflow-hidden">
          <header className="border-b border-edge px-4 py-2.5">
            <span className="eyebrow eyebrow-strong">Artifacts</span>
          </header>
          <div className="space-y-2 p-3">
            {run.liveUrl ? (
              <Artifact
                href={run.liveUrl}
                icon={<ExternalLink className="h-3.5 w-3.5" />}
                label="Live product"
                value={run.liveUrl.replace(/^https?:\/\//, "")}
                tone="pass"
              />
            ) : null}
            {run.repoUrl ? (
              <Artifact
                href={run.repoUrl}
                icon={<GithubIcon className="h-3.5 w-3.5" />}
                label="Repository"
                value={run.repoUrl.replace(/^https?:\/\//, "")}
              />
            ) : null}
            {run.status === "done" ? (
              <div className="rounded-[10px] border border-brand/25 bg-brand/[0.06] px-3 py-2.5">
                <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-brand">
                  <Package className="h-3 w-3" />
                  proof pack
                </p>
                <p className="mt-1 text-[11.5px] leading-snug text-t3">
                  screenshots · trace · console and network logs attached to this run
                </p>
              </div>
            ) : null}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

/** Elapsed time from a timestamp pair; `now` is 0 until the client clock ticks. */
function elapsedOf(startedIso: string, endedIso: string | null, now: number): string {
  if (!endedIso && now === 0) return "running";
  const end = endedIso ? new Date(endedIso).getTime() : now;
  return fmtDuration(Math.max(0, end - new Date(startedIso).getTime()));
}

function Row({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "pass";
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-[12px] text-t3">{label}</span>
      <span className="flex items-center gap-2">
        {hint ? <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-pass/80">{hint}</span> : null}
        <span className={cn("tnum font-mono text-[11.5px]", tone === "pass" ? "text-pass" : "text-t1")}>{value}</span>
      </span>
    </div>
  );
}

function AgentRow({ agent }: { agent: AgentDTO }) {
  const label = agent.agent.charAt(0).toUpperCase() + agent.agent.slice(1);
  const running = agent.status === "running";
  const failed = agent.status === "failed";

  return (
    <div
      className={cn(
        "rounded-[10px] border px-3 py-2.5",
        running ? "border-brand/30 bg-brand/[0.05]" : failed ? "border-bad/30 bg-bad/[0.05]" : "border-edge bg-well/50",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <Bot className={cn("h-3.5 w-3.5 shrink-0", running ? "text-brand" : failed ? "text-bad" : "text-pass")} />
          <span className="truncate text-[12.5px] font-medium text-t1">{label}</span>
        </span>
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-brand" />
        ) : failed ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-bad" />
        ) : (
          <Check className="h-3.5 w-3.5 shrink-0 text-pass" strokeWidth={2.5} />
        )}
      </div>

      {agent.detail ? <p className="mt-1 text-[11.5px] leading-snug text-t3">{agent.detail}</p> : null}
      {agent.error ? <p className="mt-1 text-[11.5px] leading-snug text-bad">{agent.error}</p> : null}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9.5px] text-t3">
        {agent.model ? <span>{agent.model}</span> : null}
        {agent.tokens > 0 ? <span className="tnum">{fmtTokens(agent.tokens)} tok</span> : null}
        {agent.elapsedMs != null ? <span className="tnum">{fmtDuration(agent.elapsedMs)}</span> : null}
      </div>
    </div>
  );
}

function Artifact({
  href,
  icon,
  label,
  value,
  tone = "neutral",
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "neutral" | "pass";
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="lift group flex items-center gap-3 rounded-[10px] border border-edge bg-well/50 px-3 py-2.5 hover:bg-surface2"
    >
      <span className={cn("shrink-0", tone === "pass" ? "text-pass" : "text-t3")}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-medium text-t1">{label}</span>
        <span className="block truncate font-mono text-[10px] text-t3">{value}</span>
      </span>
      <ExternalLink className="h-3 w-3 shrink-0 text-t3 transition-colors group-hover:text-brand" />
    </a>
  );
}
