"use client";

import { useMemo } from "react";
import { AlertOctagon, Download, ExternalLink, RotateCcw, Share2, ShieldCheck } from "lucide-react";
import { GithubIcon } from "@/components/github-icon";
import { cn } from "@/lib/cn";
import { btn } from "@/components/kit";
import type { IssueDTO } from "@/lib/run-dto";

/* Completion + failure states. The takeover is earned: it only renders when
   the run actually finished with a real URL and a real score. The failure
   state never softens anything — it lists exactly what remains broken. */

export function CompletionTakeover({
  title,
  liveUrl,
  repoUrl,
  runId,
  qualityScore,
  iterations,
  onDismiss,
}: {
  title: string;
  liveUrl: string;
  repoUrl: string | null;
  runId: string;
  qualityScore: number | null;
  iterations: number;
  onDismiss: () => void;
}) {
  /* deterministic spark layout — same build always renders the same
     celebration, no impure randomness during render */
  const sparks = useMemo(
    () =>
      Array.from({ length: 14 }, (_, i) => ({
        left: 8 + ((i * 37) % 84),
        delay: (i % 7) * 0.18,
        size: 2 + (i % 3),
        duration: 1.3 + (i % 4) * 0.22,
      })),
    [],
  );

  return (
    <div className="rise relative overflow-hidden rounded-[16px] border border-pass/30 bg-surface">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute inset-x-0 top-0 h-32 bg-pass/[0.06]" />
        {/* golden micro-sparks — restrained, two seconds, then gone */}
        {sparks.map((s, i) => (
          <span
            key={i}
            className="gold-spark absolute bottom-6 rounded-full bg-[#e8c66a]"
            style={{ left: s.left + "%", width: s.size, height: s.size, animationDelay: s.delay + "s", animationDuration: s.duration + "s", boxShadow: "0 0 8px 1px rgba(232,198,106,0.7)" }}
          />
        ))}
        <span className="green-wave absolute inset-y-0 w-1/4 bg-gradient-to-r from-transparent via-pass/[0.08] to-transparent" />
      </div>

      <div className="relative flex flex-wrap items-center justify-between gap-5 p-5 md:p-7">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="flex h-10 w-10 items-center justify-center rounded-[12px] border border-pass/40 bg-pass/12">
              <ShieldCheck className="h-5 w-5 text-pass" />
            </span>
            <div>
              <p className="display text-[20px] font-semibold tracking-tight text-t1">Your product is live.</p>
              <p className="mt-0.5 font-mono text-[11px] text-t3">{title}</p>
            </div>
          </div>

          <a
            href={liveUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-4 block w-fit rounded-[11px] border border-pass/40 bg-pass/[0.08] px-4 py-2.5 font-mono text-[13px] text-pass transition-colors hover:bg-pass/[0.14]"
          >
            {liveUrl.replace(/^https?:\/\//, "")}
          </a>

          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.14em] text-t3">
          {qualityScore != null ? (
            <span className="tnum rounded-full border border-pass/30 bg-pass/10 px-2 py-0.5 text-pass">aaa · {qualityScore}/100</span>
          ) : (
            <span className="tnum rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 text-warn">shipped · live score not measured</span>
          )}
            <span className="tnum">{iterations + 1} test iteration{iterations === 0 ? "" : "s"}</span>
            <span>every flow verified on the live url</span>
          </p>
        </div>

        <div className="flex w-full flex-col gap-2 sm:w-auto">
          <div className="flex gap-2">
            <a href={liveUrl} target="_blank" rel="noreferrer" className={btn("primary", "md", "flex-1 font-semibold")}>
              Open
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <ShareButton url={liveUrl} />
          </div>
          <div className="flex gap-2">
            <a href={"/api/runs/" + runId + "/zip"} className={btn("outline", "md", "flex-1")}>
              <Download className="h-3.5 w-3.5" />
              .zip
            </a>
            {repoUrl ? (
              <a href={repoUrl} target="_blank" rel="noreferrer" className={btn("outline", "md", "flex-1")}>
                <GithubIcon className="h-3.5 w-3.5" />
                Repo
              </a>
            ) : null}
          </div>
          <button type="button" onClick={onDismiss} className="text-center font-mono text-[9.5px] uppercase tracking-[0.16em] text-t3 transition-colors hover:text-t1">
            back to the pipeline
          </button>
        </div>
      </div>
    </div>
  );
}

/* ———————————————————————— failure ———————————————————————— */

export function FailureState({
  error,
  issues,
  runId,
  liveUrl,
}: {
  error: string | null;
  issues: IssueDTO[];
  runId: string;
  liveUrl: string | null;
}) {
  return (
    <div className="rise rounded-[16px] border border-bad/30 bg-surface">
      <div className="flex items-start gap-3.5 px-5 py-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-bad/40 bg-bad/10">
          <AlertOctagon className="h-5 w-5 text-bad" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="display text-[15.5px] font-semibold text-t1">The pipeline stopped — here is exactly where and why.</p>
          <p className="mt-1 break-words text-[13px] leading-relaxed text-t2">{error ?? "No error detail was recorded. The activity log shows the last thing that happened."}</p>
          {liveUrl ? (
            <p className="mt-2 font-mono text-[11px] text-t3">
              last deployed url:{" "}
              <a href={liveUrl} target="_blank" rel="noreferrer" className="text-info underline decoration-info/40">
                {liveUrl.replace(/^https?:\/\//, "")}
              </a>
            </p>
          ) : null}
          {issues.length > 0 ? (
            <ul className="mt-3 space-y-1.5">
              {issues.slice(0, 6).map((i) => (
                <li key={i.id} className="flex items-start gap-2 font-mono text-[11px] text-t3">
                  <span className={cn("mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full", i.status === "fixed" ? "bg-pass" : "bg-bad")} />
                  <span className="min-w-0 break-words">{i.title}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-5 py-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-t3">nothing was faked — this run genuinely stopped</p>
        <RetryButton runId={runId} />
      </div>
    </div>
  );
}

function RetryButton({ runId }: { runId: string }) {
  return (
    <button
      type="button"
      onClick={async () => {
        const { retryRunAction } = await import("@/app/actions/runs");
        const fd = new FormData();
        fd.set("runId", runId);
        await retryRunAction(fd);
      }}
      className={btn("brand", "md", "font-semibold")}
    >
      <RotateCcw className="h-3.5 w-3.5" />
      Retry the pipeline
    </button>
  );
}

function ShareButton({ url }: { url: string }) {
  return (
    <button
      type="button"
      onClick={async () => {
        if (navigator.share) {
          await navigator.share({ title: "Built with LastMile", url, text: "Researched → coded → verified → deployed → tested, end to end." }).catch(() => undefined);
        } else {
          await navigator.clipboard.writeText(url).catch(() => undefined);
        }
      }}
      className={btn("outline", "md", "flex-1")}
    >
      Share
      <Share2 className="h-3.5 w-3.5" />
    </button>
  );
}
