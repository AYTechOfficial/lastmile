import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Activity, ArrowRight, ShieldCheck, Timer, UserCheck } from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runs } from "@/lib/schema";
import { fmtDuration, fmtTokens } from "@/lib/run-dto";
import { Sparkline } from "@/components/kit";
import { Composer } from "@/components/app/composer";
import { RunList } from "@/components/app/run-list";

export const metadata = { title: "Overview — LastMile" };

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const name = session.user.name ?? session.user.email?.split("@")[0] ?? "builder";

  const rows = await db
    .select()
    .from(runs)
    .where(eq(runs.userId, session.user.id))
    .orderBy(desc(runs.createdAt))
    .limit(60);

  const verified = rows.filter((r) => r.status === "done");
  const awaiting = rows.filter((r) => r.status === "awaiting_approval");
  const active = rows.filter((r) => !["done", "failed", "awaiting_approval"].includes(r.status)).length;
  const tokens = rows.reduce((a, r) => a + r.tokens, 0);
  // oldest → newest, so the sparkline reads left to right like a timeline
  const tokenSeries = [...rows].reverse().map((r) => r.tokens);
  const timesToVerified = verified
    .filter((r) => r.startedAt && r.completedAt)
    .map((r) => r.completedAt!.getTime() - r.startedAt!.getTime());
  const avgToVerified =
    timesToVerified.length > 0
      ? timesToVerified.reduce((a, b) => a + b, 0) / timesToVerified.length
      : null;

  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow mb-2">One sentence in · verified link out</p>
          <h1 className="display text-[26px] font-semibold leading-tight tracking-[-0.03em] text-t1 md:text-[32px]">
            {greeting()}, {name}
          </h1>
          <p className="mt-1.5 max-w-xl text-[13.5px] leading-relaxed text-t3">
            Describe the product. The Research Agent searches the live web, the spec lands here for your
            approval, and nothing ships until verification has driven the real app.
          </p>
        </div>
      </header>

      {/* a run blocked on a human is the only thing on this page that is
          actually urgent, so it goes above the composer */}
      {awaiting.length > 0 ? (
        <div className="overflow-hidden rounded-[14px] border border-warn/30 bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-warn/20 px-4 py-2.5">
            <span className="flex items-center gap-2.5">
              <UserCheck className="h-3.5 w-3.5 text-warn" />
              <span className="eyebrow text-warn">
                {awaiting.length === 1 ? "One spec is waiting on you" : `${awaiting.length} specs are waiting on you`}
              </span>
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-t3">
              nothing builds until you approve
            </span>
          </div>
          <div className="divide-y divide-edge">
            {awaiting.map((r) => (
              <Link
                key={r.id}
                href={"/dashboard/runs/" + r.id}
                className="group flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface2"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="tnum shrink-0 font-mono text-[10.5px] text-t3">
                    {"#" + String(r.runNumber).padStart(4, "0")}
                  </span>
                  <span className="min-w-0 truncate text-[13.5px] text-t1">{r.title}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-[12px] font-medium text-warn">
                  Review spec
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <Composer />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="Runs"
          value={String(rows.length)}
          hint={rows.length === 0 ? "none yet" : "all time"}
          icon={<Activity className="h-3.5 w-3.5" />}
        />
        <Tile
          label="Verified"
          value={String(verified.length)}
          hint={verified.length === 0 ? "no links shipped yet" : "passed every core flow"}
          icon={<ShieldCheck className="h-3.5 w-3.5" />}
          tone="pass"
        />
        <Tile
          label="In flight"
          value={String(active)}
          hint={
            awaiting.length > 0
              ? `${awaiting.length} waiting on your review`
              : active > 0
                ? "working now"
                : "idle"
          }
          icon={<span className={active > 0 ? "live-dot text-brand" : ""} />}
          tone={active > 0 ? "brand" : awaiting.length > 0 ? "warn" : "neutral"}
        />
        <Tile
          label="Tokens"
          value={fmtTokens(tokens)}
          hint={avgToVerified ? "avg " + fmtDuration(avgToVerified) + " to verified" : "model calls, all tiers free"}
          icon={<Timer className="h-3.5 w-3.5" />}
          spark={tokenSeries.length > 1 ? tokenSeries : undefined}
        />
      </div>

      <RunList
        runs={rows.slice(0, 30).map((r) => ({
          id: r.id,
          runNumber: r.runNumber,
          title: r.title,
          status: r.status,
          currentStage: r.currentStage,
          liveUrl: r.liveUrl,
          tokens: r.tokens,
          createdAt: r.createdAt,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
        }))}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  icon,
  tone = "neutral",
  spark,
}: {
  label: string;
  value: string;
  hint: string;
  icon?: React.ReactNode;
  tone?: "neutral" | "brand" | "pass" | "warn";
  spark?: number[];
}) {
  const valueTone =
    tone === "pass"
      ? "text-pass"
      : tone === "brand"
        ? "text-brand"
        : tone === "warn"
          ? "text-warn"
          : "text-t1";
  return (
    <div className="panel relative overflow-hidden rounded-[14px] p-4">
      <div className="flex items-center justify-between">
        <span className="eyebrow">{label}</span>
        <span
          className={
            tone === "pass"
              ? "text-pass"
              : tone === "brand"
                ? "text-brand"
                : tone === "warn"
                  ? "text-warn"
                  : "text-t3"
          }
        >
          {icon}
        </span>
      </div>
      <p className={"display tnum mt-2.5 text-[26px] font-semibold leading-none tracking-[-0.02em] " + valueTone}>
        {value}
      </p>
      <p className="mt-1.5 truncate text-[11.5px] text-t3">{hint}</p>
      {spark ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-7 opacity-70">
          <Sparkline points={spark} tone="brand" height={28} />
        </div>
      ) : null}
    </div>
  );
}
