import Link from "next/link";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { ArrowUpRight, Check, Cpu, Globe, Plug } from "lucide-react";
import { signIn } from "@/lib/auth";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { accounts } from "@/lib/schema";
import { providerStates } from "@/lib/ai/providers";
import { searchProviderStates } from "@/lib/ai/search";
import { getPlatformData } from "@/lib/platform/settings";
import { listUserProviders } from "@/lib/platform/user-providers";
import { vercelConnectionStatus } from "@/lib/platform/vercel";
import { UserProviders } from "@/components/app/user-providers";
import { VercelConnect } from "@/components/app/vercel-connect";
import { SignoutButton } from "./signout-button";
import { GithubIcon } from "@/components/github-icon";
import { Badge, Panel, btn } from "@/components/kit";

export const metadata = { title: "Settings — LastMile" };

/* Everything the pipeline needs, and nothing it does not. The engine section is
   the honest control panel: it shows which free tier is answering right now and
   exactly which variable to paste a key into. */

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const linked = await db
    .select({ provider: accounts.provider })
    .from(accounts)
    .where(eq(accounts.userId, session.user.id));
  const githubLinked = linked.some((a) => a.provider === "github");
  const own = await listUserProviders(session.user.id);

  const models = await providerStates();
  const search = await searchProviderStates(session.user.id);
  // admin-configured providers count as real capacity — same rule the header uses
  const platform = await getPlatformData();
  const adminModels = platform.providers.filter((p) => p.enabled && p.models.length > 0);
  const anyModel = adminModels.length > 0 || models.some((m) => m.configured);
  // deploy capacity, honestly surfaced: the user's connected Vercel first,
  // then the operator's token (env or Admin → Infrastructure)
  const vercel = await vercelConnectionStatus(session.user.id);

  return (
    <div className="mx-auto max-w-[820px] space-y-6">
      <header>
        <p className="eyebrow mb-2">Settings</p>
        <h1 className="display text-[26px] font-semibold tracking-[-0.03em] text-t1">Account & engine</h1>
      </header>

      {/* ————— engine ————— */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="display flex items-center gap-2 text-[15px] font-semibold text-t1">
            <Cpu className="h-4 w-4 text-brand" />
            Model providers
          </h2>
          <Badge tone={anyModel ? "pass" : "warn"} dot={!anyModel}>
            {anyModel ? "agent running on a free tier" : "no model key — degraded"}
          </Badge>
        </div>

        <Panel className="overflow-hidden">
          <div className="divide-y divide-edge">
            {models.map((m) => (
              <ProviderRow
                key={m.def.id}
                label={m.def.label}
                model={m.model}
                envKey={m.def.keyEnv}
                freeTier={m.def.freeTier}
                signupUrl={m.def.signupUrl}
                configured={m.configured}
              />
            ))}
          </div>
        </Panel>

        <p className="text-[12.5px] leading-relaxed text-t3">
          Keys are tried in the order above and the first one that answers wins, so adding a second is
          pure resilience. Paste them into{" "}
          <code className="select-all rounded bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-t2">.env.local</code>{" "}
          and restart the dev server.
        </p>
      </section>

      {/* ————— your own providers ————— */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="display flex items-center gap-2 text-[15px] font-semibold text-t1">
            <Plug className="h-4 w-4 text-brand" />
            Your providers
          </h2>
          <Badge tone={own.some((p) => p.enabled && p.models.length > 0) ? "pass" : "neutral"}>
            {own.some((p) => p.enabled && p.models.length > 0)
              ? "runs on your keys first"
              : "platform keys are used until you add your own"}
          </Badge>
        </div>

        <Panel className="p-4">
          <UserProviders providers={own} />
        </Panel>

        <p className="text-[12.5px] leading-relaxed text-t3">
          ChatGPT, Claude, OpenRouter, Groq, Cerebras, NVIDIA — anything OpenAI-compatible. Tap a preset, paste
          your key, press Fetch models, and every model it serves starts selected: tap off the ones you
          don&apos;t want, or keep them all. Your endpoints are tried before the platform&apos;s, so if you
          attach a key your runs use it; if you don&apos;t, they fall back to the platform&apos;s capacity.
        </p>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="display flex items-center gap-2 text-[15px] font-semibold text-t1">
            <Globe className="h-4 w-4 text-info" />
            Web search
          </h2>
          <Badge tone="pass">live — the Research Agent is searching</Badge>
        </div>

        <Panel className="overflow-hidden">
          <div className="divide-y divide-edge">
            {search.map((s) => (
              <ProviderRow
                key={s.id}
                label={s.label}
                model={s.keyEnv ? undefined : "no key needed"}
                envKey={s.keyEnv}
                freeTier={s.freeTier}
                signupUrl={s.signupUrl}
                configured={s.configured}
                keyless={s.id === "keyless"}
              />
            ))}
          </div>
        </Panel>

        <p className="text-[12.5px] leading-relaxed text-t3">
          Without a search key the agent still works — it falls back to keyless search and page reading.
          A dedicated provider returns longer excerpts, which makes the brief noticeably sharper.
        </p>
      </section>

      {/* ————— profile ————— */}
      <section className="space-y-3">
        <h2 className="display text-[15px] font-semibold text-t1">Profile</h2>
        <Panel className="overflow-hidden">
          <div className="divide-y divide-edge px-4">
            <Row label="Name" value={session.user.name ?? "—"} />
            <Row label="Email" value={session.user.email ?? "—"} mono />
          </div>
        </Panel>
      </section>

      {/* ————— connections ————— */}
      <section className="space-y-3">
        <h2 className="display flex items-center gap-2 text-[15px] font-semibold text-t1">
          <Plug className="h-4 w-4 text-t3" />
          Connections
        </h2>
        <Panel className="overflow-hidden">
          <div className="divide-y divide-edge">
            <div className="flex items-start justify-between gap-4 px-4 py-3.5">
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-edge bg-surface2">
                  <GithubIcon className="h-4 w-4 text-t1" />
                </span>
                <div className="min-w-0">
                  <p className="text-[13.5px] font-medium text-t1">GitHub</p>
                  <p className="mt-0.5 text-[11.5px] leading-snug text-t3">
                    {githubLinked
                      ? "linked — every run's code lands as a repo in your account, one clean commit"
                      : "connect once and the Coding Agent pushes every finished codebase to your account"}
                  </p>
                </div>
              </div>
              {githubLinked ? (
                <Badge tone="pass" className="mt-1 shrink-0">connected</Badge>
              ) : (
                <form
                  className="shrink-0"
                  action={async () => {
                    "use server";
                    await signIn("github", { redirectTo: "/dashboard/settings" });
                  }}
                >
                  <button type="submit" className={btn("outline", "sm")}>Connect GitHub</button>
                </form>
              )}
            </div>
            <div className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-edge bg-surface2">
                    <span className="flex h-4 w-4 items-center justify-center rounded bg-t1 text-[9px] font-bold text-app">
                      ▲
                    </span>
                  </span>
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-medium text-t1">Vercel</p>
                    <p className="mt-0.5 text-[11.5px] leading-snug text-t3">
                      {vercel.connected
                        ? vercel.source === "user"
                          ? "your deploys ship to your own Vercel account — the run page shows the URL the moment it's live"
                          : "the operator's Vercel hosts deploys for everyone — connect a token to host yours on your account"
                        : "no deploy token anywhere yet — connect yours (or the operator adds one) before runs can ship"}
                    </p>
                  </div>
                </div>
                <Badge tone={vercel.connected ? "pass" : "neutral"} className="mt-1 shrink-0">
                  {vercel.connected ? (vercel.source === "user" ? "your account" : "operator") : "not connected"}
                </Badge>
              </div>
              <div className="mt-3">
                <VercelConnect status={vercel} />
              </div>
            </div>
          </div>
        </Panel>
      </section>

      {/* ————— session ————— */}
      <section className="space-y-3">
        <h2 className="display text-[15px] font-semibold text-t1">Session</h2>
        <Panel className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-[12.5px] leading-relaxed text-t3">
            Signing out clears the session cookie on this device. Your runs are kept.
          </p>
          <SignoutButton />
        </Panel>
      </section>

      <p className="pb-4 text-center">
        <Link
          href="/dashboard"
          className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-t3 transition-colors hover:text-brand"
        >
          back to overview
        </Link>
      </p>
    </div>
  );
}

function ProviderRow({
  label,
  model,
  envKey,
  freeTier,
  signupUrl,
  configured,
  keyless,
}: {
  label: string;
  model?: string;
  envKey: string | null;
  freeTier: string;
  signupUrl: string | null;
  configured: boolean;
  keyless?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-[13.5px] font-medium text-t1">
          {label}
          {model ? <span className="font-mono text-[10.5px] font-normal text-t3">{model}</span> : null}
        </p>
        <p className="mt-0.5 text-[11.5px] text-t3">{freeTier}</p>
        {envKey ? (
          <code className="mt-1.5 inline-block select-all rounded bg-surface2 px-1.5 py-0.5 font-mono text-[10.5px] text-t2">
            {envKey}
          </code>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {configured ? (
          <Badge tone={keyless ? "info" : "pass"}>
            <Check className="h-2.5 w-2.5" strokeWidth={3} />
            {keyless ? "fallback" : "active"}
          </Badge>
        ) : signupUrl ? (
          <a
            href={signupUrl}
            target="_blank"
            rel="noreferrer"
            className={btn("outline", "sm", "text-[11.5px]")}
          >
            Get a free key
            <ArrowUpRight className="h-3 w-3" />
          </a>
        ) : (
          <Badge tone="neutral">not configured</Badge>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="text-[12.5px] text-t3">{label}</span>
      <span className={mono ? "font-mono text-[12px] text-t2" : "text-[13px] text-t1"}>{value}</span>
    </div>
  );
}


