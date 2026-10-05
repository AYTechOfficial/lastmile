import { desc } from "drizzle-orm";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Check, KeyRound, Plus, ShieldAlert, Square, Trash2, Users } from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { agentRuns, runs, users } from "@/lib/schema";
import { isAdminEmail, toSafeProvider, getPlatformData, type SafeProvider } from "@/lib/platform/settings";
import { fmtTokens } from "@/lib/run-dto";
import { Badge, Panel, btn } from "@/components/kit";
import { AGENT_IDS } from "@/lib/platform/settings";
import { addProviderAction, deleteProviderAction, killRunAction, setInfraTokenAction, setUserPlanAction, toggleProviderAction } from "./actions";

export const metadata = { title: "Admin — LastMile" };
export const dynamic = "force-dynamic";

/* The control room. Open only to ADMIN_EMAILS (or a single-operator install).
   Keys are shown as masks only — plaintext never leaves the server. */

export default async function AdminPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isAdminEmail(session.user.email))) redirect("/dashboard");

  const platform = await getPlatformData();
  const providers: SafeProvider[] = platform.providers.map(toSafeProvider);

  const [liveRuns, usage, people] = await Promise.all([
    db
      .select({ id: runs.id, runNumber: runs.runNumber, title: runs.title, status: runs.status, currentStage: runs.currentStage })
      .from(runs)
      .orderBy(desc(runs.createdAt))
      .limit(12),
    db
      .select({ agent: agentRuns.agent, tokens: agentRuns.tokens, model: agentRuns.model, provider: agentRuns.provider })
      .from(agentRuns)
      .orderBy(desc(agentRuns.startedAt))
      .limit(200),
    db.select({ email: users.email, plan: users.plan, id: users.id }).from(users).orderBy(desc(users.createdAt)).limit(50),
  ]);

  const active = liveRuns.filter((r) => !["done", "failed", "awaiting_approval"].includes(r.status));
  const tokensByAgent = new Map<string, number>();
  for (const u of usage) tokensByAgent.set(u.agent, (tokensByAgent.get(u.agent) ?? 0) + (u.tokens ?? 0));

  return (
    <div className="min-h-screen bg-app text-t1">
      <div className="mx-auto max-w-[1080px] space-y-7 px-4 py-8 md:px-8">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="eyebrow mb-2">control room</p>
            <h1 className="display text-[26px] font-semibold tracking-[-0.03em]">Platform admin</h1>
          </div>
          <Link href="/dashboard" className={btn("outline", "sm")}>
            back to workspace
          </Link>
        </header>

        {/* ————— kill switch ————— */}
        <section>
          <h2 className="display mb-3 flex items-center gap-2 text-[15px] font-semibold">
            <ShieldAlert className="h-4 w-4 text-bad" />
            Live runs · kill switch
          </h2>
          <Panel className="overflow-hidden">
            {active.length === 0 ? (
              <p className="px-4 py-3.5 text-[12.5px] text-t3">No runs are executing right now.</p>
            ) : (
              <div className="divide-y divide-edge">
                {active.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-t1">{r.title}</p>
                      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-brand">
                        {r.status} · {r.currentStage}
                      </p>
                    </div>
                    <form action={killRunAction}>
                      <input type="hidden" name="runId" value={r.id} />
                      <button type="submit" className={btn("danger", "sm")}>
                        <Square className="h-3 w-3" />
                        Stop run
                      </button>
                    </form>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </section>

        {/* ————— providers ————— */}
        <section>
          <h2 className="display mb-3 flex items-center gap-2 text-[15px] font-semibold">
            <KeyRound className="h-4 w-4 text-brand" />
            Model providers
          </h2>
          <Panel className="overflow-hidden">
            <div className="divide-y divide-edge">
              {providers.length === 0 ? (
                <p className="px-4 py-3.5 text-[12.5px] text-t3">
                  No admin providers yet — agents fall back to the env-key chain (free tiers). Add one here to route a plan or a specific agent to a premium model.
                </p>
              ) : (
                providers.map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-[13.5px] font-medium">
                        {p.label}
                        <Badge tone={p.enabled ? "pass" : "neutral"} dot={p.enabled}>
                          {p.enabled ? "on" : "off"}
                        </Badge>
                        <Badge tone="info">{p.plans.join(" + ")}</Badge>
                        {p.agent ? <Badge tone="brand">{p.agent} only</Badge> : null}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-[10.5px] text-t3">{p.baseUrl}</p>
                      <p className="mt-0.5 font-mono text-[10.5px] text-t2">
                        key {p.keyMask ?? "unreadable"} · models: {p.models.join(", ")}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <form action={toggleProviderAction}>
                        <input type="hidden" name="id" value={p.id} />
                        <button type="submit" className={btn("outline", "sm")}>
                          {p.enabled ? "Disable" : "Enable"}
                        </button>
                      </form>
                      <form action={deleteProviderAction}>
                        <input type="hidden" name="id" value={p.id} />
                        <button type="submit" className={btn("danger", "sm")} aria-label={"Delete " + p.label}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </form>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Panel>

          <Panel className="mt-3">
            <form action={addProviderAction} className="grid gap-3 p-4 md:grid-cols-2">
              <p className="eyebrow eyebrow-strong md:col-span-2">
                <Plus className="mr-1 inline h-3 w-3" />
                add a provider
              </p>
              <Field label="Label" name="label" placeholder="Claude (Anthropic)" required />
              <Field label="Base URL (OpenAI-compatible)" name="baseUrl" placeholder="https://api.anthropic.com/v1" required />
              <Field label="API key" name="apiKey" type="password" placeholder="sk-…" required />
              <Field label="Models (comma-separated)" name="models" placeholder="claude-sonnet-4-5, claude-opus-4-1" required />
              <label className="text-[12px] text-t2">
                <span className="mb-1 block text-t3">Reserved for agent (optional)</span>
                <select name="agent" className="h-9 w-full rounded-[9px] border border-edge bg-surface2 px-2.5 text-[13px]">
                  <option value="any">any agent</option>
                  {AGENT_IDS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="text-[12px] text-t2">
                <span className="mb-1 block text-t3">Serves plans</span>
                <span className="flex gap-3">
                  {["free", "pro"].map((pl) => (
                    <label key={pl} className="flex items-center gap-1.5">
                      <input type="checkbox" name="plans" value={pl} defaultChecked className="accent-brand" />
                      {pl}
                    </label>
                  ))}
                </span>
              </fieldset>
              <div className="md:col-span-2">
                <button type="submit" className={btn("brand", "md", "font-semibold")}>
                  Add provider
                </button>
                <span className="ml-3 font-mono text-[10px] text-t3">key is AES-256-GCM encrypted at rest, never returned to any client</span>
              </div>
            </form>
          </Panel>
        </section>

        {/* ————— infrastructure ————— */}
        <section>
          <h2 className="display mb-3 text-[15px] font-semibold">Infrastructure tokens</h2>
          <Panel className="overflow-hidden">
            <div className="divide-y divide-edge">
              {[
                { which: "github", label: "GitHub token", hint: "creates repos when the user has not linked GitHub (classic token with repo scope)" },
                { which: "vercel", label: "Vercel token", hint: "production deploys (vercel.com/account/tokens)" },
                { which: "render", label: "Render API key", hint: "deploy fallback for projects that need it" },
              ].map((row) => (
                <form key={row.which} action={setInfraTokenAction} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <input type="hidden" name="which" value={row.which} />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-t1">{row.label}</p>
                    <p className="text-[11px] text-t3">{row.hint}</p>
                  </div>
                  <span className="flex items-center gap-2">
                    <input
                      type="password"
                      name="value"
                      placeholder="paste token to set"
                      className="h-8 w-[220px] rounded-[8px] border border-edge bg-surface2 px-2.5 font-mono text-[11px]"
                    />
                    <button type="submit" className={btn("outline", "sm")}>
                      Save
                    </button>
                  </span>
                </form>
              ))}
            </div>
          </Panel>
        </section>

        {/* ————— usage ————— */}
        <section>
          <h2 className="display mb-3 text-[15px] font-semibold">Usage — tokens by agent</h2>
          <Panel className="p-4">
            {tokensByAgent.size === 0 ? (
              <p className="text-[12.5px] text-t3">No agent invocations recorded yet.</p>
            ) : (
              <div className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2">
                {[...tokensByAgent.entries()].map(([agent, tokens]) => (
                  <div key={agent} className="flex items-baseline justify-between gap-3 border-b border-edge/60 py-1.5">
                    <span className="font-mono text-[11.5px] uppercase tracking-[0.12em] text-t2">[{agent.toUpperCase()}]</span>
                    <span className="tnum font-mono text-[12px] text-t1">{fmtTokens(tokens)}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </section>

        {/* ————— people + plans ————— */}
        <section>
          <h2 className="display mb-3 flex items-center gap-2 text-[15px] font-semibold">
            <Users className="h-4 w-4 text-info" />
            People & plans
          </h2>
          <Panel className="overflow-hidden">
            <div className="divide-y divide-edge">
              {people.map((u) => (
                <div key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[12px] text-t1">{u.email}</p>
                    <Badge tone={u.plan === "pro" ? "brand" : "neutral"}>{u.plan}</Badge>
                  </div>
                  <form action={setUserPlanAction} className="flex items-center gap-2">
                    <input type="hidden" name="email" value={u.email ?? ""} />
                    <select name="plan" defaultValue={u.plan} className="h-8 rounded-[8px] border border-edge bg-surface2 px-2 font-mono text-[11.5px]">
                      <option value="free">free</option>
                      <option value="pro">pro</option>
                    </select>
                    <button type="submit" className={btn("outline", "sm")}>
                      <Check className="h-3 w-3" />
                      Set
                    </button>
                  </form>
                </div>
              ))}
            </div>
          </Panel>
        </section>
      </div>
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  placeholder,
  required,
}: {
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block text-[12px] text-t2">
      <span className="mb-1 block text-t3">{label}</span>
      <input
        type={type}
        name={name}
        required={required}
        placeholder={placeholder}
        className="h-9 w-full rounded-[9px] border border-edge bg-surface2 px-2.5 text-[13px] text-t1 placeholder:text-t3/60"
      />
    </label>
  );
}
