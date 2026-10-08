import Link from "next/link";
import {
  Activity,
  BadgeCheck,
  Coins,
  Cpu,
  Gauge,
  ShieldAlert,
  Users,
  Wallet,
} from "lucide-react";
import { getPlatformData } from "@/lib/platform/settings";
import { adminUsesDefaultPassword, panelAccess } from "@/lib/platform/admin-auth";
import { fmtMilli } from "@/lib/credits";
import { Badge, Panel } from "@/components/kit";
import { accountsWithUsage, dailySeries, overview, providerMix, recentRuns } from "./data";
import { BarSeries, Proportion, SectionCard, Stat } from "./charts";

export const metadata = { title: "Admin dashboard — LastMile" };

/* The dashboard: what the platform is doing right now, in numbers that decide
   something. Every figure here is a query against the same tables the pipeline
   writes, so nothing on this page can disagree with a run page. */

export default async function AdminDashboard() {
  const [access, stats, series, mix, runs, accounts, platform, defaultPassword] = await Promise.all([
    panelAccess(),
    overview(),
    dailySeries(14),
    providerMix(6),
    recentRuns(8),
    accountsWithUsage(5),
    getPlatformData(),
    adminUsesDefaultPassword(),
  ]);

  const health = platform.health ?? {};
  const probed = platform.providers.filter((p) => health[p.id]);
  const working = probed.filter((p) => (health[p.id]?.best ?? null) !== null);
  const enabled = platform.providers.filter((p) => p.enabled);
  const tokenTotal = mix.reduce((sum, m) => sum + m.runs, 0);

  const tokensPerDay = series.map((d) => ({ label: d.day, value: d.tokens }));
  const spendPerDay = series.map((d) => ({ label: d.day, value: d.spendMilli / 1000 }));
  const runsPerDay = series.map((d) => ({ label: d.day, value: d.runs }));

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow mb-2">Operator panel</p>
          <h1 className="display text-[24px] font-semibold tracking-[-0.03em] text-t1">Dashboard</h1>
          <p className="mt-1 text-[12.5px] text-t3">
            Signed in as {access.ok ? access.label : "operator"} · {enabled.length} of {platform.providers.length}{" "}
            provider(s) in the chain · {working.length}/{probed.length || 0} probed providers answering
          </p>
        </div>
        <Badge tone={stats.inFlight > 0 ? "brand" : "neutral"}>
          {stats.inFlight > 0 ? `${stats.inFlight} run(s) in flight` : "idle"}
        </Badge>
      </header>

      {defaultPassword ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[14px] border border-warn/30 bg-warn/10 px-4 py-3">
          <ShieldAlert className="h-4 w-4 shrink-0 text-warn" />
          <p className="text-[12.5px] text-warn">
            The panel still uses the default password. Anyone who knows the address can open it.
          </p>
          <Link href="/admin/settings" className="ml-auto text-[12.5px] font-medium text-warn underline">
            Change it
          </Link>
        </div>
      ) : null}

      {/* ————————————— the numbers ————————————— */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Runs"
          value={String(stats.runs)}
          sub={`${stats.runsToday} today · ${stats.verifiedRuns} scored 100`}
          icon={<Activity className="h-4 w-4" />}
          tone="brand"
        />
        <Stat
          label="Tokens burned"
          value={stats.tokens >= 1_000_000 ? `${(stats.tokens / 1_000_000).toFixed(2)}M` : `${Math.round(stats.tokens / 1000)}k`}
          sub={`${Math.round(stats.tokensToday / 1000)}k today`}
          icon={<Cpu className="h-4 w-4" />}
        />
        <Stat
          label="Spent by runs"
          value={fmtMilli(stats.spendMilli)}
          sub={`${fmtMilli(stats.spendTodayMilli)} today · ${fmtMilli(stats.grantedMilli)} granted`}
          icon={<Coins className="h-4 w-4" />}
          tone="pass"
        />
        <Stat
          label="Credit balances"
          value={fmtMilli(stats.balanceMilli)}
          sub={`held across ${stats.accounts} account(s)`}
          icon={<Wallet className="h-4 w-4" />}
        />
        <Stat
          label="Accounts"
          value={String(stats.accounts)}
          sub={stats.suspended > 0 ? `${stats.suspended} suspended` : "none suspended"}
          icon={<Users className="h-4 w-4" />}
          tone={stats.suspended > 0 ? "warn" : "neutral"}
        />
        <Stat
          label="Verified links"
          value={String(stats.liveUrls)}
          sub="runs that reached a live URL"
          icon={<BadgeCheck className="h-4 w-4" />}
        />
        <Stat
          label="Average score"
          value={stats.avgScore === null ? "—" : `${stats.avgScore}`}
          sub="across scored runs, out of 100"
          icon={<Gauge className="h-4 w-4" />}
          tone={(stats.avgScore ?? 0) >= 90 ? "pass" : "warn"}
        />
        <Stat
          label="Providers"
          value={`${enabled.length}`}
          sub={`${working.length} answering · ${platform.providers.length} in catalog`}
          icon={<Cpu className="h-4 w-4" />}
          tone={working.length > 0 ? "neutral" : "bad"}
        />
      </div>

      {/* ————————————— the graphs ————————————— */}
      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="Tokens per day" hint="last 14 days, across every stage" className="lg:col-span-1">
          <BarSeries
            points={tokensPerDay}
            label=""
            format={(v) =>
              v >= 1_000_000
                ? `${(v / 1_000_000).toFixed(2)}M tok`
                : v >= 1000
                  ? `${Math.round(v / 1000)}k tok`
                  : `${v} tok`
            }
          />
        </SectionCard>
        <SectionCard title="Spend per day" hint="what runs charged to balances" className="lg:col-span-1">
          <BarSeries
            points={spendPerDay}
            label=""
            color="var(--color-pass, #2fbf71)"
            format={(v) => `$${v.toFixed(3)}`}
          />
        </SectionCard>
        <SectionCard title="Runs started per day" hint="creation count, not iteration count" className="lg:col-span-1">
          <BarSeries points={runsPerDay} label="" color="var(--color-warn, #e0a53f)" format={(v) => `${v} run(s)`} />
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard
          title="Which provider answers"
          hint="successful model calls, by host"
          className="lg:col-span-2"
        >
          {mix.length === 0 ? (
            <p className="text-[12.5px] text-t3">No model run has been recorded yet.</p>
          ) : (
            <div className="space-y-3">
              {mix.map((m) => (
                <Proportion
                  key={m.provider}
                  label={m.provider}
                  value={m.runs}
                  total={tokenTotal}
                  format={(v) => `${v} call(s)`}
                />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Provider health"
          hint="from the last test sweep"
          action={
            <Link href="/admin/testing" className="text-[11.5px] text-brand hover:underline">
              Test & arrange
            </Link>
          }
        >
          {probed.length === 0 ? (
            <p className="text-[12.5px] text-t3">
              Nothing probed yet. Open Testing and run a sweep — the panel records what answers and how fast.
            </p>
          ) : (
            <div className="space-y-3">
              {probed.map((p) => {
                const h = health[p.id];
                const best = h?.best ?? null;
                const worst = Math.max(1, ...probed.map((q) => health[q.id]?.best ?? 1));
                return (
                  <Proportion
                    key={p.id}
                    label={`${p.label}${p.enabled ? "" : " (off)"}`}
                    value={best === null ? 0 : worst - best + 1}
                    total={worst}
                    color={best === null ? "var(--color-bad, #e0584f)" : "var(--color-pass, #2fbf71)"}
                    format={() => (best === null ? "no model answered" : `${best}ms fastest`)}
                  />
                );
              })}
            </div>
          )}
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard
          title="Latest runs"
          hint="every account"
          className="lg:col-span-2"
          action={
            <Link href="/admin/runs" className="text-[11.5px] text-brand hover:underline">
              All runs
            </Link>
          }
        >
          <div className="divide-y divide-edge">
            {runs.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11.5px] text-brand">#{String(r.runNumber).padStart(4, "0")}</span>
                    <p className="truncate text-[12.5px] text-t1">{r.sentence}</p>
                  </div>
                  <p className="truncate font-mono text-[10.5px] text-t3">
                    {r.email ?? "—"} · {Math.round(r.tokens / 1000)}k tok
                    {r.score !== null ? ` · q${r.score}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge
                    tone={
                      r.status === "done" ? "pass" : r.status === "failed" ? "bad" : r.status === "running" ? "brand" : "neutral"
                    }
                  >
                    {r.status === "running" ? (r.stage ?? "running") : r.status.replace(/_/g, " ")}
                  </Badge>
                  <Link href={`/dashboard/runs/${r.id}`} className="text-[11.5px] text-t3 hover:text-brand">
                    open
                  </Link>
                </div>
              </div>
            ))}
            {runs.length === 0 ? <p className="py-3 text-[12.5px] text-t3">No runs yet.</p> : null}
          </div>
        </SectionCard>

        <SectionCard
          title="Newest accounts"
          hint="with what they have spent"
          action={
            <Link href="/admin/users" className="text-[11.5px] text-brand hover:underline">
              Manage
            </Link>
          }
        >
          <div className="divide-y divide-edge">
            {accounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[12.5px] text-t1">{a.name ?? a.email}</p>
                  <p className="truncate font-mono text-[10.5px] text-t3">
                    {a.runs} run(s) · {Math.round(a.tokens / 1000)}k tok · spent {fmtMilli(a.spendMilli)}
                  </p>
                </div>
                <span className="tnum shrink-0 font-mono text-[12px] text-t1">{fmtMilli(a.credits)}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <Panel className="p-5">
        <p className="text-[12.5px] leading-relaxed text-t3">
          Dedicated panel sign-in is separate from the product: change its username, password and optional
          access code in{" "}
          <Link href="/admin/settings" className="text-brand hover:underline">
            Settings
          </Link>
          . Spend is metered per stage, so the numbers here move while a run is still in flight.
        </p>
      </Panel>
    </>
  );
}
