"use client";

import { useState, useTransition } from "react";
import { Check, Database, Loader2, MessageSquarePlus, Route as RouteIcon, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { Badge, btn } from "@/components/kit";
import { approveSpecAction, requestChangesAction } from "@/app/actions/runs";
import type { SpecDTO } from "@/lib/run-dto";

/* The only place a human is required. It is deliberately the most readable
   card in the product: the spec is what everything downstream is judged
   against, including the verification tests. */
export function SpecReview({ runId, spec }: { runId: string; spec: SpecDTO }) {
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const approve = () => {
    const fd = new FormData();
    fd.set("runId", runId);
    startTransition(async () => {
      try {
        await approveSpecAction(fd);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not approve — try again.");
      }
    });
  };

  const requestChanges = () => {
    const fd = new FormData();
    fd.set("runId", runId);
    fd.set("note", note);
    startTransition(async () => {
      try {
        await requestChangesAction(fd);
        setAsking(false);
        setNote("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not send changes — try again.");
      }
    });
  };

  return (
    <div className="relative overflow-hidden rounded-[16px] border border-warn/30 bg-surface">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-warn/[0.07]" />

      <header className="relative flex flex-wrap items-center justify-between gap-3 border-b border-warn/20 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="live-dot h-1.5 w-1.5 text-warn" />
          <span className="eyebrow text-warn">Human checkpoint · spec v{spec.variant}</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={spec.origin === "research" ? "pass" : "neutral"}>
            {spec.origin === "research" ? "built from research" : "baseline"}
          </Badge>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-t3">
            nothing builds until you approve
          </span>
        </div>
      </header>

      <div className="relative space-y-6 p-4 md:p-5">
        <div>
          <h2 className="display text-[20px] font-semibold leading-tight tracking-[-0.02em] text-t1 md:text-[23px]">
            {spec.title}
          </h2>
          <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-t2">{spec.summary}</p>
        </div>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <Block label="Core flows · acceptance criteria" hint={`${spec.acceptance} assertions will run against your live URL`}>
              <div className="space-y-2">
                {spec.flows.map((f, i) => (
                  <div key={f.name} className="rounded-[11px] border border-edge bg-well/50 p-3.5">
                    <p className="flex items-start gap-2.5 text-[13px] font-medium text-t1">
                      <span className="tnum mt-[1px] font-mono text-[10.5px] text-brand">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      {f.name}
                    </p>
                    <ul className="mt-2 space-y-1 pl-[26px]">
                      {f.criteria.map((c) => (
                        <li key={c} className="flex gap-2 text-[12px] leading-snug text-t2">
                          <Check className="mt-[3px] h-3 w-3 shrink-0 text-pass/70" strokeWidth={2.5} />
                          {c}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Block>

            {spec.scope ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Block label="In scope">
                  <ul className="space-y-1.5">
                    {spec.scope.in.map((s) => (
                      <li key={s} className="flex gap-2 text-[12px] leading-snug text-t2">
                        <Check className="mt-[3px] h-3 w-3 shrink-0 text-pass/70" strokeWidth={2.5} />
                        {s}
                      </li>
                    ))}
                  </ul>
                </Block>
                <Block label="Deliberately out">
                  <ul className="space-y-1.5">
                    {spec.scope.out.map((s) => (
                      <li key={s} className="flex gap-2 text-[12px] leading-snug text-t3">
                        <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-t3/60" />
                        {s}
                      </li>
                    ))}
                  </ul>
                </Block>
              </div>
            ) : null}
          </div>

          <div className="space-y-4">
            <Block label="Stack">
              <div className="flex flex-wrap gap-1.5">
                {spec.stack.map((s) => (
                  <span
                    key={s}
                    className="rounded-full border border-edge bg-well px-2.5 py-1 font-mono text-[10.5px] text-t2"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </Block>

            {spec.dataModel?.length ? (
              <Block label="Data model" icon={<Database className="h-3 w-3" />}>
                <div className="space-y-2">
                  {spec.dataModel.map((t) => (
                    <div key={t.table} className="rounded-[10px] border border-edge bg-well/60 px-3 py-2">
                      <p className="font-mono text-[11px] text-brand">{t.table}</p>
                      <ul className="mt-1 space-y-0.5">
                        {t.columns.map((c) => (
                          <li key={c} className="font-mono text-[10.5px] text-t3">
                            {c}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </Block>
            ) : null}

            {spec.routes?.length ? (
              <Block label="Routes" icon={<RouteIcon className="h-3 w-3" />}>
                <ul className="space-y-1.5">
                  {spec.routes.map((r) => (
                    <li key={r.path} className="leading-snug">
                      <p className="font-mono text-[11px] text-t2">{r.path}</p>
                      <p className="text-[11.5px] text-t3">{r.purpose}</p>
                    </li>
                  ))}
                </ul>
              </Block>
            ) : null}

            {spec.risks.length > 0 ? (
              <Block label="Risks">
                <ul className="space-y-1.5">
                  {spec.risks.map((r) => (
                    <li key={r} className="flex gap-2 text-[12px] leading-snug text-t2">
                      <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-warn/70" />
                      {r}
                    </li>
                  ))}
                </ul>
              </Block>
            ) : null}
          </div>
        </div>

        <div className="border-t border-edge pt-4">
          {error ? (
            <p role="alert" className="mb-3 rounded-[10px] border border-bad/30 bg-bad/10 px-3 py-2 text-[12.5px] text-bad">
              {error}
            </p>
          ) : null}

          {asking ? (
            <div className="space-y-2.5">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={400}
                autoFocus
                placeholder="What should change? Be specific — the spec is revised against this note."
                className="w-full resize-none rounded-[11px] border border-edge bg-well px-3.5 py-2.5 text-[13px] text-t1 outline-none transition-colors placeholder:text-t3 focus:border-warn/50"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={requestChanges} disabled={pending} className={btn("primary", "md")}>
                  {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquarePlus className="h-3.5 w-3.5" />}
                  Send changes → new spec
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAsking(false);
                    setNote("");
                  }}
                  className={btn("ghost", "md")}
                >
                  Cancel
                </button>
                <span className="tnum ml-auto font-mono text-[10px] text-t3">{note.length}/400</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2.5">
              <button type="button" onClick={approve} disabled={pending} className={btn("primary", "lg", "font-semibold")}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" strokeWidth={2.5} />}
                Approve spec — start building
              </button>
              <button type="button" onClick={() => setAsking(true)} disabled={pending} className={btn("outline", "lg")}>
                Request changes
              </button>
              <span className="flex items-center gap-2 text-[12px] text-t3">
                <ShieldCheck className="h-3.5 w-3.5 text-pass/70" />
                {spec.acceptance} assertions will be verified on the live URL
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Block({
  label,
  hint,
  icon,
  children,
  className,
}: {
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(className)}>
      <div className="mb-2 flex items-center gap-2">
        <span className="eyebrow flex items-center gap-1.5">
          {icon}
          {label}
        </span>
        {hint ? <span className="font-mono text-[9.5px] text-t3/70">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}
