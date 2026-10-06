"use client";

import { useMemo, useState } from "react";
import { ChevronDown, History } from "lucide-react";
import { cn } from "@/lib/cn";
import { Empty } from "@/components/kit";
import { RunRow, type RunListRow } from "./run-row";

type Filter = "all" | "active" | "verified";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "In flight" },
  { id: "verified", label: "Verified" },
];

const PAGE = 8;

export function RunList({ runs }: { runs: RunListRow[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);

  const counts = useMemo(
    () => ({
      all: runs.length,
      active: runs.filter((r) => !["done", "failed"].includes(r.status)).length,
      verified: runs.filter((r) => r.status === "done").length,
    }),
    [runs],
  );

  const filtered = useMemo(() => {
    if (filter === "active") return runs.filter((r) => !["done", "failed"].includes(r.status));
    if (filter === "verified") return runs.filter((r) => r.status === "done");
    return runs;
  }, [runs, filter]);

  const visible = filtered.slice(0, shown);

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="display text-[15px] font-semibold tracking-tight text-t1">Runs</h2>
          <span className="tnum font-mono text-[10.5px] text-t3">{counts.all}</span>
        </div>

        <div className="flex items-center gap-1 rounded-[10px] border border-edge bg-surface p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setFilter(f.id);
                setShown(PAGE);
              }}
              className={cn(
                "flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[12px] transition-colors",
                filter === f.id ? "bg-surface3 font-medium text-t1" : "text-t3 hover:text-t2",
              )}
            >
              {f.label}
              <span className={cn("tnum font-mono text-[9.5px]", filter === f.id ? "text-t3" : "text-t3/70")}>
                {counts[f.id]}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3">
        {filtered.length === 0 ? (
          <div className="panel rounded-[14px]">
            <Empty
              icon={<History className="h-4.5 w-4.5" />}
              title={counts.all === 0 ? "No runs yet" : "Nothing in this filter"}
              body={
                counts.all === 0
                  ? "Describe your product in one sentence above. The Research Agent starts immediately — you can watch it work."
                  : "Switch back to All to see everything you have run."
              }
            />
          </div>
        ) : (
          <div className="panel overflow-hidden rounded-[14px] p-1.5">
            <div className="divide-y divide-edge">
              {visible.map((r) => (
                <RunRow key={r.id} run={r} />
              ))}
            </div>
            {filtered.length > shown ? (
              <button
                type="button"
                onClick={() => setShown((s) => s + PAGE)}
                className="flex w-full items-center justify-center gap-1.5 border-t border-edge py-2.5 text-[12px] text-t3 transition-colors hover:bg-surface2 hover:text-t1"
              >
                <ChevronDown className="h-3.5 w-3.5" />
                Show {Math.min(PAGE, filtered.length - shown)} more
              </button>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
