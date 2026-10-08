import Link from "next/link";
import { Badge } from "@/components/kit";
import { StopRunButton } from "../../admin-forms";
import { overview, recentRuns } from "../data";
import { SectionCard } from "../charts";

export const metadata = { title: "Runs — LastMile Admin" };

const TONE: Record<string, "neutral" | "brand" | "pass" | "warn" | "bad"> = {
  done: "pass",
  running: "brand",
  queued: "neutral",
  awaiting_approval: "warn",
  failed: "bad",
  cancelled: "neutral",
};

export default async function AdminRunsPage() {
  const [runs, stats] = await Promise.all([recentRuns(60), overview()]);

  return (
    <>
      <header>
        <p className="eyebrow mb-2">Pipeline</p>
        <h1 className="display text-[22px] font-semibold tracking-[-0.03em] text-t1">Runs</h1>
        <p className="mt-1.5 max-w-[760px] text-[12.5px] leading-relaxed text-t3">
          Every run on the platform, whoever started it. Stop ends a run wherever it is — queued, in a stage,
          or waiting at a checkpoint — and the owner sees it cancelled rather than vanished.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-[14px] border border-edge bg-surface p-4">
          <p className="eyebrow">In flight</p>
          <p className="tnum mt-2 font-mono text-[22px] font-semibold text-brand">{stats.inFlight}</p>
        </div>
        <div className="rounded-[14px] border border-edge bg-surface p-4">
          <p className="eyebrow">Verified</p>
          <p className="tnum mt-2 font-mono text-[22px] font-semibold text-pass">{stats.verifiedRuns}</p>
          <p className="mt-1 text-[11.5px] text-t3">scored 100/100</p>
        </div>
        <div className="rounded-[14px] border border-edge bg-surface p-4">
          <p className="eyebrow">Live URLs</p>
          <p className="tnum mt-2 font-mono text-[22px] font-semibold text-t1">{stats.liveUrls}</p>
        </div>
        <div className="rounded-[14px] border border-edge bg-surface p-4">
          <p className="eyebrow">Average score</p>
          <p className="tnum mt-2 font-mono text-[22px] font-semibold text-t1">{stats.avgScore ?? "—"}</p>
        </div>
      </div>

      <SectionCard title="Recent runs" hint="newest first">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse">
            <thead>
              <tr className="border-b border-edge text-left">
                <th className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.12em] text-t3">Run</th>
                <th className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.12em] text-t3">Owner</th>
                <th className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.12em] text-t3">Tokens</th>
                <th className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.12em] text-t3">Score</th>
                <th className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.12em] text-t3">Live</th>
                <th className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.12em] text-t3">Status</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {runs.map((r) => {
                const active = r.status === "running" || r.status === "queued" || r.status === "awaiting_approval";
                return (
                  <tr key={r.id}>
                    <td className="py-2.5 pr-3">
                      <Link href={`/dashboard/runs/${r.id}`} className="font-mono text-[11.5px] text-brand hover:underline">
                        #{String(r.runNumber).padStart(4, "0")}
                      </Link>
                      <p className="max-w-[260px] truncate text-[12px] text-t1">{r.sentence}</p>
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className="font-mono text-[11px] text-t3">{r.email ?? "—"}</span>
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-[11.5px] text-t2">{Math.round(r.tokens / 1000)}k</td>
                    <td className="py-2.5 pr-3 font-mono text-[11.5px] text-t2">{r.score ?? "—"}</td>
                    <td className="py-2.5 pr-3">
                      {r.liveUrl ? (
                        <a
                          href={r.liveUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="max-w-[200px] truncate font-mono text-[11px] text-brand hover:underline"
                        >
                          {r.liveUrl.replace(/^https?:\/\//, "")}
                        </a>
                      ) : (
                        <span className="text-[11px] text-t3">—</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge tone={TONE[r.status] ?? "neutral"}>
                        {r.status === "running" ? (r.stage ?? "running") : r.status.replace(/_/g, " ")}
                      </Badge>
                    </td>
                    <td className="py-2.5 text-right">
                      {active ? <StopRunButton runId={r.id} label="Stop" /> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {runs.length === 0 ? <p className="py-3 text-[12.5px] text-t3">No runs yet.</p> : null}
        </div>
      </SectionCard>
    </>
  );
}
