import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { adminAuthState, panelAccess, seedAdminDefaults } from "@/lib/platform/admin-auth";
import { Panel } from "@/components/kit";
import { AdminLoginForm } from "./login-form";

export const metadata = { title: "Admin sign-in — LastMile" };

/* Dynamic for a stronger reason than the panel's other pages: this page seeds
   the default credentials when the panel has none, and a build must never write
   a password hash into a production database. */
export const dynamic = "force-dynamic";

/* The panel's door.

   Deliberately its own page, outside the product's shell: this is where the
   platform is administered, not where it is used, and mixing the two is how an
   operator ends up clicking Stop on their own production run by accident. */

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ changed?: string }>;
}) {
  /* Already inside? Go straight through — a signed-in operator does not need to
     log in twice. */
  const access = await panelAccess();
  if (access.ok) redirect("/admin");

  const { changed } = await searchParams;

  /* First visit: the panel has no credentials, so it takes the documented
     default (admin / admin, no access code) and the dashboard warns until it is
     changed. An unenterable panel is a panel nobody configures. */
  const seeded = await seedAdminDefaults();
  const state = await adminAuthState();

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink px-4 py-10">
      <div className="w-full max-w-[420px] space-y-5">
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-[14px] border border-brand/30 bg-brand/10">
            <ShieldCheck className="h-5 w-5 text-brand" />
          </div>
          <p className="eyebrow mb-1">Operator panel</p>
          <h1 className="display text-[22px] font-semibold tracking-[-0.03em] text-t1">LastMile Admin</h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-t3">
            Providers, models, accounts and the credit economy. A separate sign-in from the product —
            nothing here is reachable from a normal account.
          </p>
        </div>

        <Panel className="p-5">
          {changed ? (
            <p className="mb-4 rounded-[10px] border border-pass/25 bg-pass/10 px-3.5 py-2.5 text-[12px] text-pass">
              Credentials changed. Sign in again with the new ones.
            </p>
          ) : null}
          {seeded ? (
            <p className="mb-4 rounded-[10px] border border-warn/25 bg-warn/10 px-3.5 py-2.5 text-[12px] text-warn">
              The panel is new, so it starts with <span className="font-mono">admin</span> /{" "}
              <span className="font-mono">admin</span>. Change that in Settings once you are in.
            </p>
          ) : null}
          <AdminLoginForm requiresCode={state.requiresCode} />
        </Panel>

        <p className="text-center text-[11.5px] text-t3">
          Operators whose address is on the environment list can also reach the panel with their
          product account.{" "}
          <Link href="/login" className="text-brand hover:underline">
            Product sign-in
          </Link>
        </p>
      </div>
    </div>
  );
}
