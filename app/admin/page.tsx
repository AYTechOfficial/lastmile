import { desc, eq, sql } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Activity, KeyRound, LayoutGrid, Users, Wallet, Wrench } from "lucide-react";
import { auth, isAdminEmail } from "@/lib/auth";
import { db } from "@/lib/db";
import { creditEvents, runs, users } from "@/lib/schema";
import { getPlatformData } from "@/lib/platform/settings";
import { PINNABLE_AGENTS, PROVIDER_PRESETS } from "@/lib/platform/catalog";
import { fmtMilli } from "@/lib/credits";
import { Badge, Panel } from "@/components/kit";
import {
  AccountList,
  CreditGrantForm,
  CreditPricingForm,
  InfraForm,
  PolicyForm,
  ProviderCatalog,
  StopRunButton,
  type AccountRowData,
} from "./admin-forms";

export const metadata = { title: "Admin — LastMile" };

/* Testing the catalog is a sweep of real requests — twelve providers, a few
   models each — and it runs in this page's own request. The default budget on a
   serverless plan is seconds, which would cut a sweep off mid-flight and lose
   the measurements it had already taken. */
export const maxDuration = 60;

/* The operator panel.

   Everything the platform decides lives here, because a configuration that can
   only be changed by editing a database row is a configuration nobody changes:
   the model catalog and its failover order, the health of every provider, who
   may run and how much, the credit economy, and the infrastructure tokens the
   deploy path spends. */

const STATUS_TONE: Record<string, "neutral" | "brand" | "pass" | "warn" | "bad"> = {
  done: "pass",
  running: "brand",
  queued: "neutral",
  awaiting_approval: "warn",
  failed: "bad",
  cancelled: "neutral",
};

export default async function AdminPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!isAdminEmail(session.user.email)) notFound();

  const platform = await getPlatformData();

  const [accounts, ledger, recentRuns, usage] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        plan: users.plan,
        credits: users.creditsMilli,
        suspendedAt: users.suspendedAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(60),
    db
      .select({
        id: creditEvents.id,
        delta: creditEvents.deltaMilli,
        balance: creditEvents.balanceMilli,
        reason: creditEvents.reason,
        createdAt: creditEvents.createdAt,
        email: users.email,
      })
      .from(creditEvents)
      .innerJoin(users, eq(users.id, creditEvents.userId))
      .orderBy(desc(creditEvents.createdAt))
      .limit(15),
    db
      .select({
        id: runs.id,
        runNumber: runs.runNumber,
        sentence: runs.sentence,
        status: runs.status,
        stage: runs.currentStage,
        score: runs.qualityScore,
        tokens: runs.tokens,
        liveUrl: runs.liveUrl,
        createdAt: runs.createdAt,
        email: users.email,
      })
      .from(runs)
      .innerJoin(users, eq(users.id, runs.userId))
      .orderBy(desc(runs.createdAt))
      .limit(12),
    db
      .select({
        userId: runs.userId,
        runs: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(${runs.tokens}), 0)::int`,
      })
      .from(runs)
      .groupBy(runs.userId),
  ]);

  const usageById = new Map(usage.map((u) => [u.userId, u]));
  const accountRows: AccountRowData[] = accounts.map((a) => ({
    id: a.id,
    email: a.email,
    name: a.name,
    plan: a.plan,
    credits: a.credits,
    suspendedAt: a.suspendedAt ? a.suspendedAt.toISOString() : null,
    runs: usageById.get(a.id)?.runs ?? 0,
    tokens: usageById.get(a.id)?.tokens ?? 0,
    createdAt: a.createdAt.toISOString(),
  }));

  const enabledFree = platform.providers.filter((p) => p.enabled && p.tier === "free").length;
  const enabledPremium = platform.providers.filter((p) => p.enabled && p.tier === "premium").length;
  const probed = Object.keys(platform.health ?? {}).length;

  return (
    <div className="mx-auto max-w-[1060px] space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow mb-2">Operator</p>
          <h1 className="display text-[26px] font-semibold tracking-[-0.03em] text-t1">Admin</h1>
          <p className="mt-1 text-[12.5px] text-t3">
            {platform.providers.length} provider(s) — {enabledFree} free, {enabledPremium} premium ·{" "}
            {probed} probed · {accountRows.length} account(s) shown
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={enabledFree > 0 ? "pass" : "bad"}>free chain {enabledFree > 0 ? "ok" : "empty"}</Badge>
          <Badge tone={enabledPremium > 0 ? "info" : "neutral"}>premium {enabledPremium}</Badge>
        </div>
      </header>

      {/* ————————————— the model catalog ————————————— */}
      <section className="space-y-3">
        <h2 className="display flex items-center gap-2 text-[15px] font-semibold text-t1">
          <LayoutGrid className="h-4 w-4 text-brand" />
          Model providers & failover order
        </h2>
        <ProviderCatalog
          providers={platform.providers}
          health={platform.health ?? {}}
          presets={PROVIDER_PRESETS}
          agents={PINNABLE_AGENTS}
        />
        <p className="text-[12.5px] leading-relaxed text-t3">
          The chain walks these in order, one model per provider per pass, so a provider that is down
          costs one rung and never the run. Test sends a real one-word request to every model and records
          what answered and how fast; auto-arrange rewrites this order from those measurements, fastest
          first, and sorts each provider&apos;s own model list the same way.
        </p>
      </section>

      {/* ————————————— accounts ————————————— */}
      <section className="space-y-3">
        <h2 className="display flex items-center gap-2 text-[15px] font-semibold text-t1">
          <Users className="h-4 w-4 text-brand" />
          Accounts
        </h2>
        <AccountList accounts={accountRows.slice(0, 30)} />
        <p className="text-[12.5px] leading-relaxed text-t3">
          Suspend blocks sign-in and refuses new runs; the balance adjustment is a ledger entry, so the
          spend history stays honest. Deleting an account takes its runs and ledger rows with it.
        </p>
      </section>

      {/* ————————————— runs ————————————— */}
      <section className="space-y-3">
        <h2 className="display flex items-center gap-2 text-[15px] font-semibold text-t1">
          <Activity className="h-4 w-4 text-brand" />
          Runs
        </h2>
        <Panel className="overflow-hidden">
          <div className="divide-y divide-edge">
            {recentRuns.length === 0 ? (
              <p className="px-4 py-3 text-[12.5px] text-t3">No runs yet.</p>
            ) : (
              recentRuns.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/dashboard/runs/${r.id}`}
                        className="font-mono text-[11.5px] text-brand hover:underline"
                      >
                        #{String(r.runNumber).padStart(4, "0")}
                      </Link>
                      <p className="truncate text-[12.5px] text-t1">{r.sentence}</p>
                    </div>
                    <p className="truncate font-mono text-[10.5px] text-t3">
                      {r.email ?? "—"} · {Math.round(r.tokens / 1000)}k tok
                      {r.score !== null ? ` · q${r.score}` : ""}
                      {r.liveUrl ? ` · ${r.liveUrl.replace(/^https?:\/\//, "")}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>
                      {r.status === "running" ? r.stage ?? "running" : r.status.replace(/_/g, " ")}
                    </Badge>
                    {r.status === "running" || r.status === "queued" || r.status === "awaiting_approval" ? (
                      <StopRunButton runId={r.id} label="Stop" />
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>
      </section>

      {/* ————————————— platform policy ————————————— */}
      <section className="space-y-3">
        <h2 className="display flex items-center gap-2 text-[15px] font-semibold text-t1">
          <Wrench className="h-4 w-4 text-brand" />
          Platform
        </h2>
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel className="p-4">
            <PolicyForm free={platform.policy.free} pro={platform.policy.pro} />
          </Panel>
          <Panel className="p-4">
            <InfraForm
              hasGithub={Boolean(platform.infra.githubTokenEncrypted)}
              hasVercel={Boolean(platform.infra.vercelTokenEncrypted)}
              teamId={platform.infra.vercelTeamId}
            />
          </Panel>
        </div>
        <p className="text-[12.5px] leading-relaxed text-t3">
          Policy is the switch that decides whether a plan may reach the premium catalog. Tokens are
          stored encrypted and never shown back — paste a new one to replace it.
        </p>
      </section>

      {/* ————————————— credit economy ————————————— */}
      <section className="space-y-3">
        <h2 className="display flex items-center gap-2 text-[15px] font-semibold text-t1">
          <Wallet className="h-4 w-4 text-brand" />
          Credit economy
        </h2>
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel className="p-4">
            <CreditPricingForm
              pricePerMillion={platform.credits.pricePerMillionMilli / 1000}
              freeGrant={platform.credits.freeGrantMilli / 1000}
            />
          </Panel>
          <Panel className="p-4">
            <CreditGrantForm />
          </Panel>
        </div>
        <p className="text-[12.5px] leading-relaxed text-t3">
          A run is charged where the tokens are counted: after each stage the runner converts the
          stage&apos;s token usage at the price above and writes it to the ledger. A run that would start
          on an empty balance is refused before it spends anything.
        </p>
      </section>

      {/* ————————————— ledger ————————————— */}
      <section className="space-y-3">
        <h2 className="display flex items-center gap-2 text-[15px] font-semibold text-t1">
          <KeyRound className="h-4 w-4 text-brand" />
          Credit ledger
        </h2>
        <Panel className="overflow-hidden">
          <div className="divide-y divide-edge">
            {ledger.length === 0 ? (
              <p className="px-4 py-3 text-[12.5px] text-t3">No movements yet.</p>
            ) : (
              ledger.map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-3 px-4 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[11px] text-t2">{e.email}</p>
                    <p className="truncate font-mono text-[9.5px] uppercase tracking-[0.12em] text-t3">{e.reason}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={"tnum font-mono text-[12px] " + (e.delta < 0 ? "text-bad" : "text-pass")}>
                      {e.delta < 0 ? "−" : "+"}${(Math.abs(e.delta) / 1000).toFixed(3)}
                    </p>
                    <p className="tnum font-mono text-[9.5px] text-t3">bal {fmtMilli(e.balance)}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>
      </section>
    </div>
  );
}
