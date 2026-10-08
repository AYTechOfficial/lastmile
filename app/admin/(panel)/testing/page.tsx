import { getPlatformData } from "@/lib/platform/settings";
import { Badge, Panel } from "@/components/kit";
import { TestingControls } from "../../admin-forms";
import { SectionCard } from "../charts";

export const metadata = { title: "Testing — LastMile Admin" };

/* Health, as the operator needs to read it: per model, with the answer and the
   round-trip, and with the failures kept in view. A green column that hides the
   dead models is how a provider stays "working" until a run needs it. */

export default async function AdminTestingPage() {
  const platform = await getPlatformData();
  const health = platform.health ?? {};

  const providers = [...platform.providers].sort((a, b) => b.priority - a.priority);
  const tested = providers.filter((p) => health[p.id]);
  const answering = tested.filter((p) => (health[p.id]?.best ?? null) !== null);
  const neverTested = providers.filter((p) => !health[p.id]);
  const keyless = neverTested.filter((p) => !p.keyEncrypted && !(p.keyEnv && process.env[p.keyEnv]?.trim()));

  return (
    <>
      <header>
        <p className="eyebrow mb-2">Health</p>
        <h1 className="display text-[22px] font-semibold tracking-[-0.03em] text-t1">Testing</h1>
        <p className="mt-1.5 max-w-[760px] text-[12.5px] leading-relaxed text-t3">
          A sweep sends one real one-word request to every model of every enabled provider and records what
          answered, with the round-trip in milliseconds and the failure&apos;s own status when it did not. Auto-arrange
          then rewrites the failover order — and each provider&apos;s model order — from those measurements: fastest
          first, and nothing is guessed about a provider nobody probed.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-[14px] border border-edge bg-surface p-4">
          <p className="eyebrow">Answering</p>
          <p className="tnum mt-2 font-mono text-[22px] font-semibold text-pass">{answering.length}</p>
          <p className="mt-1 text-[11.5px] text-t3">of {tested.length} probed provider(s)</p>
        </div>
        <div className="rounded-[14px] border border-edge bg-surface p-4">
          <p className="eyebrow">Never probed</p>
          <p className="tnum mt-2 font-mono text-[22px] font-semibold text-warn">{neverTested.length}</p>
          <p className="mt-1 text-[11.5px] text-t3">
            {keyless.length > 0 ? `${keyless.length} with no key at all` : "all configured"}
          </p>
        </div>
        <div className="rounded-[14px] border border-edge bg-surface p-4">
          <p className="eyebrow">Fastest model</p>
          <p className="tnum mt-2 font-mono text-[22px] font-semibold text-brand">
            {(() => {
              const best = tested
                .map((p) => ({ p, ms: health[p.id]?.best ?? null }))
                .filter((x): x is { p: (typeof tested)[number]; ms: number } => x.ms !== null)
                .sort((a, b) => a.ms - b.ms)[0];
              return best ? `${best.ms}ms` : "—";
            })()}
          </p>
          <p className="mt-1 truncate text-[11.5px] text-t3">
            {(() => {
              const best = tested
                .map((p) => ({ p, ms: health[p.id]?.best ?? null }))
                .filter((x): x is { p: (typeof tested)[number]; ms: number } => x.ms !== null)
                .sort((a, b) => a.ms - b.ms)[0];
              return best ? best.p.label : "run a sweep first";
            })()}
          </p>
        </div>
      </div>

      <TestingControls />

      <SectionCard title="Results by provider and model" hint="newest sweep wins per model">
        {tested.length === 0 ? (
          <p className="text-[12.5px] text-t3">
            No sweep has run yet. Press Test all above — it takes a few seconds and writes what it finds here.
          </p>
        ) : (
          <div className="space-y-5">
            {tested.map((p) => {
              const h = health[p.id];
              const models = Object.entries(h?.models ?? {});
              const up = models.filter(([, m]) => m.ok).length;
              return (
                <div key={p.id} className="rounded-[12px] border border-edge p-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <p className="text-[13px] font-medium text-t1">{p.label}</p>
                    <Badge tone={p.tier === "premium" ? "brand" : "neutral"}>{p.tier}</Badge>
                    {!p.enabled ? <Badge tone="warn">disabled</Badge> : null}
                    <Badge tone={up === 0 ? "bad" : up === models.length ? "pass" : "warn"}>
                      {up}/{models.length} answering
                    </Badge>
                    <span className="ml-auto font-mono text-[10.5px] text-t3">
                      probed {h?.at ? new Date(h.at).toLocaleString() : "just now"} · priority {p.priority}
                    </span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {models.map(([model, m]) => (
                      <div
                        key={model}
                        className="flex items-center justify-between gap-2 rounded-[10px] border border-edge bg-well/40 px-3 py-2"
                      >
                        <span className="min-w-0 truncate font-mono text-[11px] text-t2">{model}</span>
                        <span className="shrink-0">
                          {m.ok ? (
                            <Badge tone="pass">{m.ms}ms</Badge>
                          ) : (
                            <Badge tone={m.status === 404 || m.status === 410 ? "warn" : "bad"}>
                              {m.status === 0 ? "no answer" : `HTTP ${m.status}`}
                            </Badge>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                  {models.length === 0 ? (
                    <p className="text-[12px] text-t3">No model recorded for this provider yet.</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      {keyless.length > 0 ? (
        <Panel className="p-5">
          <p className="mb-2 text-[13px] font-medium text-t1">Configured but unreachable</p>
          <p className="text-[12.5px] leading-relaxed text-t3">
            These providers are in the catalog and enabled, but their key did not resolve, so they are not in
            the chain at all — no request will ever be sent to them until a key is stored or the env var is set.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {keyless.map((p) => (
              <span key={p.id} className="rounded-full border border-warn/30 bg-warn/10 px-3 py-1 font-mono text-[11px] text-warn">
                {p.label}
                {p.keyEnv ? ` · set ${p.keyEnv}` : " · no key field"}
              </span>
            ))}
          </div>
        </Panel>
      ) : null}
    </>
  );
}
