"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  CornerDownLeft,
  LayoutDashboard,
  LogOut,
  Plus,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Kbd } from "@/components/kit";
import { signOutAction } from "@/app/actions/auth";

export type PaletteRun = { id: string; runNumber: number; title: string; status: string };

type Action = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: React.ComponentType<{ className?: string }>;
  perform?: () => void;
};

const pad = (n: number) => "#" + String(n).padStart(4, "0");

/* ⌘K. Navigation, the two real actions, and every recent run.
   The dialog is mounted only while open, so its input state starts fresh every
   time without an effect to reset it. */
export function CommandPalette({
  open,
  onOpenChange,
  runs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runs: PaletteRun[];
}) {
  if (!open) return null;
  return <PaletteDialog onOpenChange={onOpenChange} runs={runs} />;
}

function PaletteDialog({
  onOpenChange,
  runs,
}: {
  onOpenChange: (open: boolean) => void;
  runs: PaletteRun[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const actions = useMemo<Action[]>(() => {
    const base: Action[] = [
      {
        id: "new",
        label: "Start a new run",
        hint: "one sentence in",
        group: "Actions",
        icon: Plus,
        perform: () => router.push("/dashboard#compose"),
      },
      {
        id: "overview",
        label: "Go to overview",
        group: "Navigate",
        icon: LayoutDashboard,
        perform: () => router.push("/dashboard"),
      },
      {
        id: "settings",
        label: "Go to account settings",
        group: "Navigate",
        icon: Settings,
        perform: () => router.push("/dashboard/settings"),
      },
      {
        id: "marketing",
        label: "Open the marketing site",
        group: "Navigate",
        icon: Sparkles,
        perform: () => router.push("/"),
      },
      {
        id: "signout",
        label: "Sign out",
        group: "Session",
        icon: LogOut,
        perform: () => {
          void signOutAction();
        },
      },
    ];
    const runActions: Action[] = runs.map((r) => ({
      id: r.id,
      label: r.title,
      hint: pad(r.runNumber) + " · " + r.status.replace(/_/g, " "),
      group: "Recent runs",
      icon: ArrowRight,
      perform: () => router.push("/dashboard/runs/" + r.id),
    }));
    return [...base, ...runActions];
  }, [router, runs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => (a.label + " " + (a.hint ?? "") + " " + a.group).toLowerCase().includes(q));
  }, [actions, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, Action[]>();
    for (const a of filtered) {
      const list = map.get(a.group) ?? [];
      list.push(a);
      map.set(a.group, list);
    }
    return [...map.entries()];
  }, [filtered]);

  // focus the input on mount; no state is touched here
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = filtered[active];
      if (chosen) {
        onOpenChange(false);
        chosen.perform?.();
      }
    }
  }

  let flatIndex = -1;

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-[3px]"
      />
      <div className="rise panel-2 relative w-full max-w-[560px] overflow-hidden rounded-[16px] shadow-[0_40px_100px_-20px_rgba(0,0,0,0.9)]">
        <div className="flex items-center gap-2.5 border-b border-edge px-4">
          <Search className="h-4 w-4 shrink-0 text-t3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search runs and actions…"
            className="h-12 min-w-0 flex-1 bg-transparent text-[14px] text-t1 outline-none placeholder:text-t3"
          />
          <Kbd>esc</Kbd>
        </div>

        <div ref={listRef} className="thin-scroll max-h-[46vh] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-t3">Nothing matches “{query}”.</p>
          ) : (
            grouped.map(([group, items]) => (
              <div key={group} className="mb-1 last:mb-0">
                <p className="eyebrow px-2.5 py-2">{group}</p>
                {items.map((a) => {
                  flatIndex++;
                  const index = flatIndex;
                  const Icon = a.icon;
                  const isActive = index === active;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      data-index={index}
                      onMouseMove={() => setActive(index)}
                      onClick={() => {
                        onOpenChange(false);
                        a.perform?.();
                      }}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors",
                        isActive ? "bg-surface3" : "hover:bg-surface2",
                      )}
                    >
                      <Icon className={cn("h-4 w-4 shrink-0", isActive ? "text-brand" : "text-t3")} />
                      <span className="min-w-0 flex-1 truncate text-[13.5px] text-t1">{a.label}</span>
                      {a.hint ? (
                        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-t3">
                          {a.hint}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-edge bg-well/60 px-4 py-2.5">
          <div className="flex items-center gap-3 text-[11px] text-t3">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              move
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>
                <CornerDownLeft className="h-2.5 w-2.5" />
              </Kbd>
              open
            </span>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-t3">lastmile</span>
        </div>
      </div>
    </div>
  );
}
