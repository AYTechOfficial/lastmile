import { getPlatformData } from "@/lib/platform/settings";
import { PINNABLE_AGENTS, PROVIDER_PRESETS } from "@/lib/platform/catalog";
import { ProviderCatalog } from "../../admin-forms";

export const metadata = { title: "Providers — LastMile Admin" };

export default async function AdminProvidersPage() {
  const platform = await getPlatformData();
  /* The list renders in FAILOVER order — priority, highest first — because that
     is the order the pipeline actually walks. It used to render the stored
     array order, which only auto-arrange ever rewrote, so a manual drag saved
     new priorities and the refresh drew the untouched array: the operator's
     arrangement came back “undone” while the chain was really running it. */
  const ordered = [...platform.providers].sort((a, b) => b.priority - a.priority);
  const free = ordered.filter((p) => p.tier === "free");
  const premium = ordered.filter((p) => p.tier === "premium");

  return (
    <>
      <header>
        <p className="eyebrow mb-2">Model catalog</p>
        <h1 className="display text-[22px] font-semibold tracking-[-0.03em] text-t1">Providers</h1>
        <p className="mt-1.5 max-w-[720px] text-[12.5px] leading-relaxed text-t3">
          The chain walks these in order. Within one pass every provider gets one attempt before any provider
          gets a second, so a host that is down costs a rung and never the run. Drag a row to set the order
          yourself, or test first and let auto-arrange set it from measurements.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-edge px-3 py-1 font-mono text-[11px] text-t3">
          {free.length} free-tier
        </span>
        <span className="rounded-full border border-edge px-3 py-1 font-mono text-[11px] text-t3">
          {premium.length} premium-tier
        </span>
        <span className="rounded-full border border-edge px-3 py-1 font-mono text-[11px] text-t3">
          {platform.providers.filter((p) => p.enabled).length} enabled
        </span>
      </div>

      <ProviderCatalog
        providers={ordered}
        health={platform.health ?? {}}
        presets={PROVIDER_PRESETS}
        agents={PINNABLE_AGENTS}
      />
    </>
  );
}
