import Link from "next/link";
import { adminAuthState, adminUsesDefaultPassword } from "@/lib/platform/admin-auth";
import { getPlatformData } from "@/lib/platform/settings";
import { AdminCredentialsForm, CloudBrowserToggle, InfraForm, PolicyForm } from "../../admin-forms";
import { SectionCard } from "../charts";

export const metadata = { title: "Settings — LastMile Admin" };

export default async function AdminSettingsPage() {
  const [platform, auth, defaultPassword] = await Promise.all([
    getPlatformData(),
    adminAuthState(),
    adminUsesDefaultPassword(),
  ]);

  const freeCatalog = platform.providers.filter((p) => p.tier === "free").length;
  const premiumCatalog = platform.providers.filter((p) => p.tier === "premium").length;

  return (
    <>
      <header>
        <p className="eyebrow mb-2">Platform</p>
        <h1 className="display text-[22px] font-semibold tracking-[-0.03em] text-t1">Settings</h1>
        <p className="mt-1.5 max-w-[760px] text-[12.5px] leading-relaxed text-t3">
          The panel&apos;s own credentials, which catalog each plan may reach, and the tokens the deploy path
          spends. Secrets are stored encrypted and never shown back — paste a new value to replace one.
        </p>
      </header>

      {defaultPassword ? (
        <div className="rounded-[14px] border border-warn/30 bg-warn/10 px-4 py-3 text-[12.5px] text-warn">
          The panel is still on the default password. Set a real one below — this is the only thing standing
          between the public internet and the platform&apos;s models, budgets and accounts.
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Panel credentials"
          hint="this sign-in only — changing them signs every other device out"
        >
          <AdminCredentialsForm username={auth.username} requiresCode={auth.requiresCode} />
        </SectionCard>

        <SectionCard
          title="Plan policy"
          hint={`${freeCatalog} provider(s) in the free catalog · ${premiumCatalog} in premium`}
        >
          <PolicyForm free={platform.policy.free} pro={platform.policy.pro} />
          <p className="mt-4 text-[11.5px] leading-relaxed text-t3">
            This is the switch that keeps a free run on free models and a Pro run on the premium catalog. It
            applies to the next job, with no deploy.
          </p>
        </SectionCard>

        <SectionCard
          title="Live verification browser"
          hint="whose browser drives the Live QA stage"
        >
          <CloudBrowserToggle enabled={platform.liveBrowser?.cloudForAll === true} />
        </SectionCard>

        <SectionCard
          title="Infrastructure"
          hint="GitHub for the generated repositories, Vercel for the deploys"
          className="lg:col-span-2"
        >
          <InfraForm
            hasGithub={Boolean(platform.infra.githubTokenEncrypted)}
            hasVercel={Boolean(platform.infra.vercelTokenEncrypted)}
            teamId={platform.infra.vercelTeamId}
          />
        </SectionCard>

        <SectionCard title="Access model" hint="how the panel decides who is an operator" className="lg:col-span-2">
          <div className="space-y-3 text-[12.5px] leading-relaxed text-t3">
            <p>
              <span className="text-t1">Panel sign-in (primary).</span> A username and password kept in the
              platform settings, independent of any product account. The optional access code is a second
              factor: when it is set, the login asks for it after the password.
            </p>
            <p>
              <span className="text-t1">Operator accounts (recovery).</span> A signed-in product account whose
              address is on the environment list can also open the panel. That is the way back in if the panel
              credentials are ever lost — set them again from{" "}
              <Link href="/admin/settings" className="text-brand hover:underline">
                this page
              </Link>
              , or from the environment if the list itself changed.
            </p>
            <p>
              Sessions last twelve hours, are signed with the server secret, and stop being accepted the moment
              the password changes.
            </p>
          </div>
        </SectionCard>
      </div>
    </>
  );
}
