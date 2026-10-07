import { notFound, redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { auth, isAdminEmail } from "@/lib/auth";
import { db } from "@/lib/db";
import { creditEvents, users } from "@/lib/schema";
import { getPlatformData } from "@/lib/platform/settings";
import { fmtMilli } from "@/lib/credits";
import { Wallet, KeyRound, Users } from "lucide-react";
import { Badge, Panel } from "@/components/kit";
import { CreditPricingForm, CreditGrantForm } from "./admin-forms";

export const metadata = { title: "Admin — LastMile" };

/* The operator panel. Deliberately small: the credit economy, the user list,
   and a read-only view of the platform configuration everything else reads. */

export default async function AdminPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!isAdminEmail(session.user.email)) notFound();

  const platform = await getPlatformData();

  const accounts = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      plan: users.plan,
      credits: users.creditsMilli,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(25);

  const ledger = await db
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
    .limit(15);

  return (
    <div className="mx-auto max-w-[900px] space-y-6">
      <header>
        <p className="eyebrow mb-2">Operator</p>
        <h1 className="display text-[26px] font-semibold tracking-[-0.03em] text-t1">Admin</h1>
      </header>

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

      <section className="space-y-3">
        <h2 className="display flex items-center gap-2 text-[15px] font-semibold text-t1">
          <Users className="h-4 w-4 text-brand" />
          Accounts
        </h2>
        <Panel className="overflow-hidden">
          <div className="divide-y divide-edge">
            {accounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-t1">{a.name ?? "—"}</p>
                  <p className="truncate font-mono text-[10.5px] text-t3">{a.email}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2.5">
                  <Badge tone={a.plan === "pro" ? "brand" : "neutral"}>{a.plan}</Badge>
                  <span className="tnum font-mono text-[12px] text-t1">{fmtMilli(a.credits)}</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </section>

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
