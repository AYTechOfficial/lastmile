"use client";

import { useEffect, useMemo, useState } from "react";
import { File, Folder, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { Empty } from "@/components/kit";

/* Code viewer — the real workspace the Coding Agent produced. File tree on the
   left, file body on the right, loaded from the code API on demand. */

type TreeNode = { path: string; dir: boolean };

export function CodeViewer({ runId, live }: { runId: string; live: boolean }) {
  const [files, setFiles] = useState<TreeNode[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    fetch("/api/runs/" + runId + "/code", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { files: [] }))
      .then((d: { files?: string[] }) => {
        const list = (d.files ?? []).map((p) => ({ path: p, dir: p.endsWith("/") }));
        setFiles(list);
        setSelected((cur) => cur ?? list.find((f) => !f.dir && f.path.endsWith("page.tsx"))?.path ?? list.find((f) => !f.dir)?.path ?? null);
      })
      .catch(() => setFiles([]));
  };

  // fetch on mount — deferred one frame so state updates never happen in the
  // effect body itself, keeping the react-compiler purity rules happy
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(load);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, reloadKey]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      if (cancelled) return;
      setLoading(true);
      fetch("/api/runs/" + runId + "/code?file=" + encodeURIComponent(selected), { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { content: null }))
        .then((d: { content?: string }) => {
          if (!cancelled) setContent(d.content ?? "// file unavailable");
        })
        .catch(() => {
          if (!cancelled) setContent("// failed to load");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [runId, selected]);

  const grouped = useMemo(() => {
    if (!files) return [];
    const dirs = new Map<string, TreeNode[]>();
    for (const f of files) {
      const top = f.path.includes("/") ? f.path.slice(0, f.path.indexOf("/")) : "(root)";
      if (!dirs.has(top)) dirs.set(top, []);
      dirs.get(top)!.push(f);
    }
    return [...dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files]);

  if (files && files.length === 0) {
    return (
      <Empty
        icon={<Folder className="h-5 w-5" />}
        title="No code yet"
        body="The Coding Agent writes the codebase here the moment it starts — files appear live as they land."
      />
    );
  }

  return (
    <div className="grid overflow-hidden rounded-[14px] border border-edge lg:grid-cols-[230px_minmax(0,1fr)]" style={{ height: 480 }}>
      <div className="thin-scroll overflow-y-auto border-b border-edge bg-well py-2 lg:border-b-0 lg:border-r">
        {grouped.map(([dir, items]) => (
          <div key={dir} className="px-2 py-1">
            <p className="flex items-center gap-1.5 px-1.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-t3">
              {dir === "(root)" ? <File className="h-3 w-3" /> : <Folder className="h-3 w-3" />}
              {dir}
            </p>
            {items.map((f) => {
              const name = f.dir ? f.path : f.path.slice(f.path.indexOf("/") + 1 || 0);
              return (
                <button
                  key={f.path}
                  type="button"
                  disabled={f.dir}
                  onClick={() => setSelected(f.path)}
                  className={cn(
                    "block w-full truncate rounded-[7px] px-2 py-1 text-left font-mono text-[11px] transition-colors",
                    f.dir ? "text-t3/70" : selected === f.path ? "bg-brand/15 text-brand" : "text-t2 hover:bg-surface2",
                  )}
                >
                  {name}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="relative min-w-0 bg-well">
        <div className="flex items-center justify-between gap-2 border-b border-edge px-3.5 py-2">
          <span className="truncate font-mono text-[10.5px] text-t2">{selected ?? "select a file"}</span>
          {live ? (
            <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-t3 transition-colors hover:text-brand">
              <RefreshCw className="h-3 w-3" />
              refresh
            </button>
          ) : null}
        </div>
        <pre className="thin-scroll h-[calc(100%-37px)] overflow-auto px-4 py-3 font-mono text-[11px] leading-[1.7] text-t2">
          {loading ? "loading…" : content}
        </pre>
      </div>
    </div>
  );
}
