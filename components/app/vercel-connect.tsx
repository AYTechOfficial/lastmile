"use client";

import { useState, useTransition } from "react";
import { ArrowUpRight, TriangleAlert } from "lucide-react";
import { connectVercelAction, disconnectVercelAction } from "@/app/actions/settings";
import { btn } from "@/components/kit";

/* Settings → Connections → Vercel. Deploys resolve the run owner's token
   first, so connecting here moves that user's builds to THEIR Vercel
   account; without a connection they ride on the operator's. */

export type VercelStatus = {
  connected: boolean;
  account: string | null;
  source: "user" | "platform" | null;
};

const input =
  "w-full rounded-lg border border-edge bg-surface2/40 px-3 py-2 text-[13px] text-t1 outline-none transition-colors placeholder:text-t3 focus:border-brand";

export function VercelConnect({ status }: { status: VercelStatus }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, start] = useTransition();

  async function submit(fd: FormData) {
    setError(null);
    setBusy(true);
    try {
      const res = await connectVercelAction(fd);
      if (!res.ok) setError(res.error ?? "Could not connect");
      else setOpen(false);
    } catch {
      setError("Something went wrong — try again");
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    start(async () => {
      await disconnectVercelAction();
      setOpen(false);
    });
  }

  /* the user's own connection is live */
  if (status.connected && status.source === "user") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-pass/25 bg-pass/[0.06] px-3 py-2.5">
        <p className="min-w-0 text-[12.5px] leading-snug text-t2">
          Connected as <span className="font-mono text-[12px] text-pass">@{status.account ?? "you"}</span> — your runs
          deploy to <span className="text-t1">your</span> Vercel account.
        </p>
        <button type="button" onClick={disconnect} disabled={pending} className={btn("outline", "sm")}>
          {pending ? "Disconnecting…" : "Disconnect"}
        </button>
      </div>
    );
  }

  /* the operator's token is hosting deploys — offer the upgrade */
  if (status.connected && status.source === "platform" && !open) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-edge bg-surface2/30 px-3 py-2.5">
        <p className="min-w-0 text-[12.5px] leading-snug text-t3">
          Deploys currently go live on the <span className="text-t2">operator&apos;s Vercel</span>. Connect your own token to
          host them on your account instead.
        </p>
        <button type="button" onClick={() => setOpen(true)} className={btn("outline", "sm")}>
          Connect your Vercel
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 rounded-lg border border-edge p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12.5px] font-medium text-t1">Connect Vercel</p>
        <a
          href="https://vercel.com/account/settings/tokens"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-[11.5px] text-t3 transition-colors hover:text-brand"
        >
          Create a token
          <ArrowUpRight className="h-3 w-3" />
        </a>
      </div>
      <form action={submit} className="space-y-2.5">
        <input name="token" type="password" placeholder="Vercel token — vercel.com/account/settings/tokens" className={input} required />
        <input name="teamId" placeholder="Team id (optional — for team-scoped deploys)" className={input} />
        <div className="flex items-center gap-2">
          <button type="submit" disabled={busy || pending} className={btn("brand", "sm")}>
            {busy ? "Verifying…" : "Connect"}
          </button>
          {status.connected || open ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              className={btn("ghost", "sm")}
            >
              Cancel
            </button>
          ) : null}
          <span className="text-[11px] leading-snug text-t3">
            verified against Vercel, then stored encrypted
          </span>
        </div>
        {error && (
          <p className="flex items-start gap-1.5 text-[11.5px] text-bad">
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
            {error}
          </p>
        )}
      </form>
      {!status.connected && (
        <p className="text-[11px] leading-relaxed text-t3">
          No connection yet — deploys can only go live once someone&apos;s token is here. The operator&apos;s token counts as the
          fallback for everyone.
        </p>
      )}
    </div>
  );
}
