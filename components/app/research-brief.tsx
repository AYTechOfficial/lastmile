import Link from "next/link";
import { AlertTriangle, ArrowUpRight, BookOpen, Globe, Layers, Target, Users } from "lucide-react";
import { cn } from "@/lib/cn";
import { Badge, Panel, type Tone } from "@/components/kit";
import { fmtDuration, fmtTokens, type ResearchDTO } from "@/lib/run-dto";

/* The Research Agent's actual output. Everything here was gathered from the
   open web in this run — the sources list at the bottom is the receipt for
   every claim above it. */

const QUALITY: Record<ResearchDTO["quality"], { label: string; tone: Tone; note: string }> = {
  full: {
    label: "full analysis",
    tone: "pass",
    note: "model-planned searches, pages read, brief synthesized from live sources",
  },
  "search-only": {
    label: "search only",
    tone: "warn",
    note: "sources are real, but the analysis was assembled without a model — add a key in settings for deeper synthesis",
  },
  offline: {
    label: "baseline",
    tone: "bad",
    note: "nothing reachable — this brief is a deterministic starting point, not research",
  },
};

export function ResearchBrief({ brief }: { brief: ResearchDTO }) {
  const q = QUALITY[brief.quality] ?? QUALITY.offline;

  return (
    <Panel className="overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="eyebrow eyebrow-strong">Research brief</span>
          <Badge tone={q.tone}>{q.label}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-t3">
          {brief.providerLabel ? (
            <span className="flex items-center gap-1.5">
              <Layers className="h-3 w-3" />
              {brief.providerLabel} · {brief.model}
            </span>
          ) : null}
          <span className="flex items-center gap-1.5">
            <Globe className="h-3 w-3" />
            {brief.searchProvider}
          </span>
          <span className="tnum">{brief.sources.length} sources</span>
          <span className="tnum">{fmtTokens(brief.tokens)} tok</span>
          <span className="tnum">{fmtDuration(brief.elapsedMs)}</span>
        </div>
      </header>

      <div className="space-y-5 p-4">
        {brief.quality !== "full" ? (
          <div className="flex items-start gap-3 rounded-[12px] border border-warn/25 bg-warn/[0.06] px-3.5 py-3">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
            <p className="text-[12.5px] leading-relaxed text-t2">
              {q.note}
              {" "}
              <Link href="/dashboard/settings" className="text-warn underline decoration-warn/40 underline-offset-2 hover:decoration-warn">
                Open settings
              </Link>
            </p>
          </div>
        ) : null}

        {brief.positioning ? (
          <div>
            <SectionLabel icon={<Target className="h-3 w-3" />}>Positioning</SectionLabel>
            <p className="mt-2 text-[15px] leading-relaxed text-t1">{brief.positioning}</p>
          </div>
        ) : null}

        {brief.gap ? (
          <div className="rounded-[12px] border border-brand/25 bg-brand/[0.06] px-4 py-3.5">
            <p className="eyebrow text-brand">The gap</p>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-t1">{brief.gap}</p>
          </div>
        ) : null}

        {brief.audience.length > 0 ? (
          <div>
            <SectionLabel icon={<Users className="h-3 w-3" />}>Who it is for</SectionLabel>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {brief.audience.map((a) => (
                <span
                  key={a}
                  className="rounded-full border border-edge bg-surface2 px-2.5 py-1 text-[11.5px] text-t2"
                >
                  {a}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {brief.competitors.length > 0 ? (
          <div>
            <SectionLabel icon={<Target className="h-3 w-3" />}>
              Comparable products · {brief.competitors.length}
            </SectionLabel>
            <div className="mt-2 space-y-2">
              {brief.competitors.map((c) => (
                <div key={c.url + c.name} className="rounded-[12px] border border-edge bg-surface2/40 p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      className="group flex min-w-0 items-center gap-1.5"
                    >
                      <span className="truncate text-[13.5px] font-medium text-t1">{c.name}</span>
                      <ArrowUpRight className="h-3 w-3 shrink-0 text-t3 transition-colors group-hover:text-brand" />
                    </a>
                    <span className="shrink-0 rounded-full border border-edge bg-well px-2 py-[2px] font-mono text-[9.5px] text-t3">
                      {c.pricing}
                    </span>
                  </div>
                  {c.what ? <p className="mt-1.5 text-[12.5px] leading-relaxed text-t2">{c.what}</p> : null}
                  {c.gaps.length > 0 ? (
                    <ul className="mt-2 space-y-1">
                      {c.gaps.map((g) => (
                        <li key={g} className="flex gap-2 text-[12px] leading-snug text-t3">
                          <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-brand/60" />
                          {g}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="grid gap-5 md:grid-cols-2">
          {brief.stack.length > 0 ? (
            <div>
              <SectionLabel icon={<Layers className="h-3 w-3" />}>Stack the brief recommends</SectionLabel>
              <ul className="mt-2 space-y-2">
                {brief.stack.map((s) => (
                  <li key={s.name} className="rounded-[10px] border border-edge bg-well/60 px-3 py-2">
                    <p className="font-mono text-[11.5px] text-t1">{s.name}</p>
                    {s.why ? <p className="mt-0.5 text-[11.5px] leading-snug text-t3">{s.why}</p> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {brief.productionChecklist.length > 0 ? (
            <div>
              <SectionLabel icon={<BookOpen className="h-3 w-3" />}>Shipping to production</SectionLabel>
              <ol className="mt-2 space-y-1.5">
                {brief.productionChecklist.map((c, i) => (
                  <li key={c} className="flex gap-2.5 text-[12.5px] leading-snug text-t2">
                    <span className="tnum shrink-0 font-mono text-[10px] text-t3">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    {c}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>

        {brief.risks.length > 0 ? (
          <div>
            <SectionLabel icon={<AlertTriangle className="h-3 w-3" />} className="text-warn">
              Risks
            </SectionLabel>
            <ul className="mt-2 space-y-1.5">
              {brief.risks.map((r) => (
                <li key={r} className="flex gap-2.5 text-[12.5px] leading-snug text-t2">
                  <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-warn/70" />
                  {r}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {brief.pricing.length > 0 ? (
          <div>
            <SectionLabel icon={<Globe className="h-3 w-3" />}>Pricing signals</SectionLabel>
            <ul className="mt-2 space-y-1.5">
              {brief.pricing.map((p) => (
                <li key={p.claim} className="text-[12.5px] leading-snug text-t2">
                  {p.claim}
                  {p.source ? <span className="ml-2 font-mono text-[10px] text-t3">{p.source}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {brief.sources.length > 0 ? (
          <details className="group border-t border-edge pt-3">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[12px] text-t3 transition-colors hover:text-t1">
              <Globe className="h-3 w-3" />
              <span className="tnum">{brief.sources.length} sources read</span>
              <span className="text-t3/60 group-open:hidden">— show</span>
              <span className="hidden text-t3/60 group-open:inline">— hide</span>
            </summary>
            <ul className="mt-2.5 space-y-1.5">
              {brief.sources.map((s) => (
                <li key={s.url} className="flex min-w-0 items-baseline gap-2.5">
                  <span className="shrink-0 font-mono text-[10px] text-t3">{s.host}</span>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 truncate text-[12px] text-t2 transition-colors hover:text-brand"
                  >
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </Panel>
  );
}

function SectionLabel({
  children,
  icon,
  className,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("eyebrow flex items-center gap-2", className)}>
      {icon}
      {children}
    </p>
  );
}
