"use client";

import { useState } from "react";
import { ExternalLink, Monitor, RefreshCw, Smartphone } from "lucide-react";
import { cn } from "@/lib/cn";
import { Empty, btn } from "@/components/kit";

/* Live Preview — the deployed product, embedded. Only appears once a real
   URL exists; there is no fake preview. */

export function LivePreview({ liveUrl }: { liveUrl: string | null }) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [nonce, setNonce] = useState(0);

  if (!liveUrl) {
    return (
      <Empty
        icon={<ExternalLink className="h-5 w-5" />}
        title="Not deployed yet"
        body="The Deploy Agent ships the build to production and the live URL appears here — embedded, in this tab."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setDevice("desktop")}
            className={cn("flex h-8 items-center gap-1.5 rounded-[9px] border px-2.5 text-[12px]", device === "desktop" ? "border-brand/40 bg-brand/10 text-brand" : "border-edge text-t3 hover:text-t2")}
          >
            <Monitor className="h-3.5 w-3.5" />
            Desktop
          </button>
          <button
            type="button"
            onClick={() => setDevice("mobile")}
            className={cn("flex h-8 items-center gap-1.5 rounded-[9px] border px-2.5 text-[12px]", device === "mobile" ? "border-brand/40 bg-brand/10 text-brand" : "border-edge text-t3 hover:text-t2")}
          >
            <Smartphone className="h-3.5 w-3.5" />
            Mobile
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden font-mono text-[10.5px] text-t3 sm:inline">{liveUrl.replace(/^https?:\/\//, "")}</span>
          <button type="button" onClick={() => setNonce((n) => n + 1)} className={btn("ghost", "sm")} aria-label="Reload preview">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <a href={liveUrl} target="_blank" rel="noreferrer" className={btn("outline", "sm")}>
            Open in new tab
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>

      <div className="overflow-hidden rounded-[14px] border border-edge bg-well p-2">
        <div
          className={cn(
            "relative mx-auto overflow-hidden rounded-[10px] border border-edge bg-app transition-[width] duration-500",
            device === "mobile" ? "w-[390px] max-w-full" : "w-full",
          )}
          style={{ height: 520 }}
        >
          <iframe
            key={device + "-" + nonce}
            src={liveUrl}
            title="Live product preview"
            className="h-full w-full"
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        </div>
      </div>
      <p className="text-center font-mono text-[9.5px] uppercase tracking-[0.14em] text-t3">
        embedded live — some sites disallow embedding; use “open in new tab” if this stays blank
      </p>
    </div>
  );
}
