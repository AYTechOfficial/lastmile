"use client";

import { useState, useTransition } from "react";
import { Loader2, Trash2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { deleteRunAction } from "@/app/actions/runs";

/* Delete a project, in two steps: the first click asks, the second commits.
   Deliberately a sibling of the row's Link — a button inside a link is
   invalid HTML and would navigate when the user meant to delete. */
export function RunDeleteButton({ runId, className }: { runId: string; className?: string }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  if (pending) {
    return (
      <span className={cn("flex h-7 w-7 items-center justify-center", className)} aria-live="polite">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-bad" />
      </span>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        title="Delete this project"
        aria-label="Delete this project"
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-[8px] border border-edge bg-surface/90 text-t3 shadow-[0_4px_14px_-6px_rgba(0,0,0,0.8)] transition-colors hover:border-bad/40 hover:text-bad",
          className,
        )}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    );
  }

  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-[9px] border border-bad/40 bg-app/95 p-0.5 shadow-[0_8px_24px_-10px_rgba(0,0,0,0.9)]",
        className,
      )}
      role="alertdialog"
      aria-label="Confirm delete"
    >
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(() => {
            const fd = new FormData();
            fd.set("runId", runId);
            void deleteRunAction(fd);
          })
        }
        className="rounded-[7px] bg-bad/15 px-2 py-1 font-mono text-[9.5px] uppercase tracking-[0.12em] text-bad transition-colors hover:bg-bad/25"
      >
        Delete
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        aria-label="Cancel"
        className="flex h-6 w-6 items-center justify-center rounded-[7px] text-t3 transition-colors hover:text-t1"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
