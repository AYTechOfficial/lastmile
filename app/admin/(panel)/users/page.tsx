import { getPlatformData } from "@/lib/platform/settings";
import { fmtMilli } from "@/lib/credits";
import { AccountList, CreditGrantForm, CreditPricingForm } from "../../admin-forms";
import { accountsWithUsage, recentLedger } from "../data";
import { SectionCard } from "../charts";

export const metadata = { title: "Users — LastMile Admin" };

export default async function AdminUsersPage() {
  const [accounts, ledger, platform] = await Promise.all([
    accountsWithUsage(200),
    recentLedger(20),
    getPlatformData(),
  ]);

  const totalBalance = accounts.reduce((sum, a) => sum + a.credits, 0);
  const totalSpend = accounts.reduce((sum, a) => sum + a.spendMilli, 0);
  const suspended = accounts.filter((a) => a.suspendedAt).length;

  return (
    <>
      <header>
        <p className="eyebrow mb-2">Accounts</p>
        <h1 className="display text-[22px] font-semibold tracking-[-0.03em] text-t1">Users</h1>
        <p className="mt-1.5 max-w-[760px] text-[12.5px] leading-relaxed text-t3">
          Set a plan, adjust a balance, suspend or reinstate access, delete an account. Suspension is enforced
          where it matters — sign-in is refused and a suspended owner cannot start a run — and every balance
          change is a ledger entry, so the spend history stays honest.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-[14px] border border-edge bg-surface p-4">
          <p className="eyebrow">Accounts</p>
          <p className="tnum mt-2 font-mono text-[22px] font-semibold text-t1">{accounts.length}</p>
          <p className="mt-1 text-[11.5px] text-t3">{suspended} suspended</p>
        </div>
        <div className="rounded-[14px] border border-edge bg-surface p-4">
          <p className="eyebrow">Balances held</p>
          <p className="tnum mt-2 font-mono text-[22px] font-semibold text-brand">{fmtMilli(totalBalance)}</p>
          <p className="mt-1 text-[11.5px] text-t3">across every account</p>
        </div>
        <div className="rounded-[14px] border border-edge bg-surface p-4">
          <p className="eyebrow">Charged by runs</p>
          <p className="tnum mt-2 font-mono text-[22px] font-semibold text-pass">{fmtMilli(totalSpend)}</p>
          <p className="mt-1 text-[11.5px] text-t3">lifetime, metered per stage</p>
        </div>
      </div>

      <SectionCard title="All accounts" hint="expand a row to change plan, balance or access">
        <AccountList accounts={accounts} />
      </SectionCard>

      <SectionCard title="Credit economy" hint="what a run costs and what a new account starts with">
        <div className="grid gap-5 lg:grid-cols-2">
          <CreditPricingForm
            pricePerMillion={platform.credits.pricePerMillionMilli / 1000}
            freeGrant={platform.credits.freeGrantMilli / 1000}
          />
          <CreditGrantForm />
        </div>
      </SectionCard>

      <SectionCard title="Ledger" hint="every balance movement, newest first">
        <div className="divide-y divide-edge">
          {ledger.length === 0 ? (
            <p className="py-3 text-[12.5px] text-t3">No movements yet.</p>
          ) : (
            ledger.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate font-mono text-[11.5px] text-t2">{e.email}</p>
                  <p className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-t3">{e.reason}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={"tnum font-mono text-[12px] " + (e.delta < 0 ? "text-bad" : "text-pass")}>
                    {e.delta < 0 ? "−" : "+"}${(Math.abs(e.delta) / 1000).toFixed(3)}
                  </p>
                  <p className="tnum font-mono text-[10px] text-t3">bal {fmtMilli(e.balance)}</p>
                </div>
              </div>
            ))
          )}
        </div>
      </SectionCard>
    </>
  );
}
