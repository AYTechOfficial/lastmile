import { Check, ImageIcon, Minus, Terminal, Wrench, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Panel } from "@/components/kit";
import { fmtDuration, type RunFlowDTO } from "@/lib/run-dto";
import { flowCount } from "./status";

/* Verification receipts: one row per core flow from the spec, with the outcome
   of the run against the live URL. This is the product's whole argument, so it
   is rendered as evidence and not as a score. */

type Row = {
  position: number;
  name: string;
  assertions: number | null;
  status: string;
  attempts: number;
  durationMs: number | null;
};

export function Receipts({
  flows,
  spec,
  done,
  verifying,
  report,
}: {
  flows: RunFlowDTO[];
  spec: { flows?: { name: string }[] } | null;
  done: boolean;
  verifying: boolean;
  report?: {
    consoleErrors: string[];
    screenshotCount: number;
    flowsTotal: number;
    flowsPassed: number;
    assertions: number;
    score: number;
    browser: string;
  } | null;
}) {
  const total = flowCount(spec);
  const specNames = spec?.flows?.map((f) => f.name) ?? [];

  const byPosition = new Map<number, RunFlowDTO>();
  for (const f of [...flows].sort((a, b) => (a.durationMs ?? 0) - (b.durationMs ?? 0))) {
    if (!byPosition.has(f.position)) byPosition.set(f.position, f);
  }

  const rows: Row[] = Array.from({ length: total }, (_, i) => {
    const f = byPosition.get(i);
    return {
      position: i,
      name: f?.name ?? specNames[i] ?? `Core flow ${i + 1}`,
      assertions: f?.assertions ?? null,
      status: f?.status ?? "pending",
      attempts: f?.attempts ?? 0,
      durationMs: f?.durationMs ?? null,
    };
  });

  const passed = rows.filter((r) => r.status === "pass" || r.status === "fixed").length;
  const fixed = rows.filter((r) => r.status === "fixed").length;
  const failed = rows.filter((r) => r.status === "fail").length;
  const frac = total === 0 ? 0 : passed / total;

  return (
    <Panel className="overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
        <span className="eyebrow eyebrow-strong">Verification receipts</span>
        <span className="flex items-center gap-3 font-mono text-[10px] text-t3">
          {fixed > 0 ? <span className="text-warn">{fixed} auto-fixed</span> : null}
          {failed > 0 ? <span className="text-bad">{failed} failing</span> : null}
          <span className="tnum text-t2">
            {passed}/{total} flows
          </span>
        </span>
      </header>

      <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_188px]">
        <div className="space-y-1.5">
          {rows.map((r, i) => (
            <div
              key={r.position}
              className={cn(
                "flex items-center justify-between gap-3 rounded-[11px] border px-3 py-2.5 transition-colors",
                r.status === "pending" ? "border-edge/60 bg-well/40" : "border-edge bg-well/70",
              )}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="tnum shrink-0 font-mono text-[10px] text-t3">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0">
                  <p className={cn("truncate text-[12.5px]", r.status === "pending" ? "text-t3" : "font-medium text-t1")}>
                    {r.name}
                  </p>
                  <p className="font-mono text-[9.5px] tracking-wide text-t3">
                    {r.assertions != null ? `${r.assertions} assertions · chromium` : verifying ? "running…" : "queued for verification"}
                  </p>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {r.durationMs != null ? (
                  <span className="tnum font-mono text-[10px] text-t3">{fmtDuration(r.durationMs)}</span>
                ) : null}
                {r.status === "pass" ? (
                  <span className="flex items-center gap-1 rounded-full border border-pass/30 bg-pass/10 px-2 py-[3px] font-mono text-[9px] uppercase tracking-[0.1em] text-pass">
                    <Check className="h-2.5 w-2.5" strokeWidth={3} />
                    pass
                  </span>
                ) : r.status === "fixed" ? (
                  <span className="flex items-center gap-1 rounded-full border border-warn/30 bg-warn/10 px-2 py-[3px] font-mono text-[9px] uppercase tracking-[0.1em] text-warn">
                    <Wrench className="h-2.5 w-2.5" />
                    fixed · att {r.attempts}
                  </span>
                ) : r.status === "fail" ? (
                  <span className="flex items-center gap-1 rounded-full border border-bad/30 bg-bad/10 px-2 py-[3px] font-mono text-[9px] uppercase tracking-[0.1em] text-bad">
                    <X className="h-2.5 w-2.5" strokeWidth={3} />
                    fail
                  </span>
                ) : (
                  <span className="rounded-full border border-edge bg-surface2 px-2 py-[3px] font-mono text-[9px] uppercase tracking-[0.1em] text-t3">
                    pending
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-3">
          <Ring frac={frac} done={done} passed={passed} total={total} />

          <div className="space-y-1.5 border-t border-edge pt-3">
            <Meta
              icon={<Terminal className="h-3 w-3" />}
              label="console errors"
              value={report ? String(report.consoleErrors.length) : "--"}
              tone={report && report.consoleErrors.length > 0 ? "bad" : "neutral"}
            />
            <Meta icon={<Minus className="h-3 w-3" />} label="assertions run" value={report ? String(report.assertions) : "--"} />
            <Meta icon={<ImageIcon className="h-3 w-3" />} label="screenshots" value={report ? String(report.screenshotCount) : "--"} />
            <Meta icon={<Terminal className="h-3 w-3" />} label="browser" value={report ? report.browser : "--"} />
          </div>
        </div>
      </div>
    </Panel>
  );
}

function Ring({ frac, done, passed, total }: { frac: number; done: boolean; passed: number; total: number }) {
  const C = 2 * Math.PI * 34;
  return (
    <div className="relative mx-auto h-[86px] w-[86px]">
      <svg viewBox="0 0 86 86" className="h-full w-full -rotate-90">
        <circle cx="43" cy="43" r="34" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="5" />
        <circle
          cx="43"
          cy="43"
          r="34"
          fill="none"
          stroke={done ? "var(--app-pass)" : "var(--app-brand)"}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - frac)}
          className="transition-[stroke-dashoffset] duration-700 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <p className="display tnum text-[19px] font-semibold leading-none text-t1">
          {passed}
          <span className="text-t3">/{total}</span>
        </p>
        <p className="eyebrow mt-1">flows</p>
      </div>
    </div>
  );
}

function Meta({ icon, label, value, tone = "neutral" }: { icon: React.ReactNode; label: string; value: string; tone?: "neutral" | "bad" }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-[11px] text-t3">
        {icon}
        {label}
      </span>
      <span className={cn("tnum font-mono text-[10.5px]", value === "--" ? "text-t3" : tone === "bad" ? "text-bad" : "text-t2")}>{value}</span>
    </div>
  );
}
