"use server";

import { desc, eq, ilike, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { auth, isAdminEmail } from "@/lib/auth";
import { panelAccess } from "@/lib/platform/admin-auth";
import { db } from "@/lib/db";
import { runs, users } from "@/lib/schema";
import { getPlatformData, updatePlatformData } from "@/lib/platform/settings";
import {
  autoArrange,
  deleteProvider,
  saveHealth,
  saveProvider,
  setAgentPins,
  setProviderEnabled,
  setProviderOrder,
  validateProvider,
  type ProviderInput,
} from "@/lib/platform/catalog";
import { probeModel, type ProbeResult } from "@/lib/ai/chat";
import { decryptSecret } from "@/lib/crypto";
import { grantCredits } from "@/lib/credits";
import { logEvent } from "@/lib/events";
import { cancelQueuedForRun } from "@/lib/queue";
import type { ModelTier, PlanId } from "@/lib/plans";

/* Operator-only actions. Every one re-checks access server-side — the panel is
   behind its own login, and the NAV being hidden is presentation, not security.

   The shape of the panel decides the shape of these: the provider list is
   edited in place (so there is a save action rather than a wizard), probed by a
   button (so testing is its own action), and reordered by dragging (so the
   order arrives as a list of ids, not as a form field per row). */

/** Who is acting: a panel session has no user row behind it, an operator
    account does. The id is what lets "you cannot delete yourself" mean
    something without breaking the panel path. */
type AdminActor = { label: string; userId: string | null };

async function requireAdmin(): Promise<AdminActor | null> {
  const access = await panelAccess();
  if (!access.ok) return null;
  if (access.as === "operator") {
    const session = await auth();
    return { label: access.label, userId: session?.user?.id ?? null };
  }
  return { label: access.label, userId: null };
}

export type AdminResult = { ok: boolean; error?: string; notice?: string };

function refresh(): void {
  revalidatePath("/admin");
  revalidatePath("/dashboard");
}

/* ————————————————————————— the credit economy ————————————————————————— */

/** Set the credit economy: price per 1M tokens and the signup grant. */
export async function setCreditPricingAction(
  _prev: AdminResult,
  formData: FormData,
): Promise<AdminResult> {
  if (!(await requireAdmin())) return { ok: false, error: "Admins only." };

  const price = Number(String(formData.get("pricePerMillion") ?? ""));
  const grant = Number(String(formData.get("freeGrant") ?? ""));

  if (!Number.isFinite(price) || price < 0 || price > 1000) {
    return { ok: false, error: "Price per million must be between $0 and $1000." };
  }
  if (!Number.isFinite(grant) || grant < 0 || grant > 1000) {
    return { ok: false, error: "The signup grant must be between $0 and $1000." };
  }

  await updatePlatformData((current) => ({
    ...current,
    credits: {
      pricePerMillionMilli: Math.round(price * 1000),
      freeGrantMilli: Math.round(grant * 1000),
    },
  }));

  refresh();
  return { ok: true, notice: "Pricing saved — the next stage charge uses it." };
}

/** Top up (or claw back, with a negative amount) a user's credits by email. */
export async function grantCreditsAction(
  _prev: AdminResult,
  formData: FormData,
): Promise<AdminResult> {
  if (!(await requireAdmin())) return { ok: false, error: "Admins only." };

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const amount = Number(String(formData.get("amount") ?? ""));

  if (!email) return { ok: false, error: "Give the account's email." };
  if (!Number.isFinite(amount) || amount === 0) {
    return { ok: false, error: "Give an amount in dollars (negative to claw back)." };
  }

  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) return { ok: false, error: `No account for ${email}.` };

  const amountMilli = Math.round(amount * 1000);
  const { balanceMilli } = await grantCredits(user.id, amountMilli, "grant:admin");

  refresh();
  return {
    ok: true,
    notice: `${amount > 0 ? "Granted" : "Clawed back"} $${Math.abs(amount).toFixed(2)} ${amount > 0 ? "to" : "from"} ${email} — new balance $${(balanceMilli / 1000).toFixed(2)}.`,
  };
}

/* ————————————————————————— the provider catalog ————————————————————————— */

function readProviderForm(formData: FormData): ProviderInput {
  return {
    id: String(formData.get("id") ?? "").trim() || null,
    label: String(formData.get("label") ?? ""),
    baseUrl: String(formData.get("baseUrl") ?? ""),
    apiKey: String(formData.get("apiKey") ?? ""),
    keyEnv: String(formData.get("keyEnv") ?? ""),
    models: String(formData.get("models") ?? ""),
    tier: String(formData.get("tier") ?? "free") as ModelTier,
    notes: String(formData.get("notes") ?? ""),
    enabled: formData.get("enabled") === "on" || formData.get("enabled") === "true",
  };
}

/** Add a provider, or save the edits to one. The key field is optional on an
    edit: leaving it blank keeps the stored key rather than disarming the
    provider, which is what an operator changing a label actually means. */
export async function saveProviderAction(
  _prev: AdminResult,
  formData: FormData,
): Promise<AdminResult> {
  if (!(await requireAdmin())) return { ok: false, error: "Admins only." };

  const input = readProviderForm(formData);
  /* An empty key on an edit means "keep the stored one", and validateProvider
     already accepts that when the entry has a keyEncrypted or a keyEnv. */
  const current = await getPlatformData();
  const { problems } = validateProvider(input, current);
  if (problems.length > 0) {
    return { ok: false, error: problems.map((p) => p.message).join(" ") };
  }

  const result = await saveProvider({
    ...input,
    apiKey: input.apiKey?.trim() ? input.apiKey : null,
    enabled: input.enabled ?? true,
  });
  if (!result.ok) return { ok: false, error: result.problems.map((p) => p.message).join(" ") };

  refresh();
  return { ok: true, notice: result.notice };
}

export async function deleteProviderAction(
  _prev: AdminResult,
  formData: FormData,
): Promise<AdminResult> {
  if (!(await requireAdmin())) return { ok: false, error: "Admins only." };
  const id = String(formData.get("id") ?? "").trim();
  const result = await deleteProvider(id);
  if (!result.ok) return { ok: false, error: result.error ?? "Could not remove that provider." };
  refresh();
  return { ok: true, notice: result.notice };
}

export async function toggleProviderAction(
  _prev: AdminResult,
  formData: FormData,
): Promise<AdminResult> {
  if (!(await requireAdmin())) return { ok: false, error: "Admins only." };
  const id = String(formData.get("id") ?? "").trim();
  const enabled = String(formData.get("enabled") ?? "") === "true";
  const result = await setProviderEnabled(id, enabled);
  if (!result.ok) return { ok: false, error: result.error ?? "Could not change that provider." };
  refresh();
  return { ok: true, notice: result.notice };
}

/** The drag ended: this is the new failover order, first reached first. */
export async function reorderProvidersAction(ids: string[]): Promise<AdminResult> {
  if (!(await requireAdmin())) return { ok: false, error: "Admins only." };
  const result = await setProviderOrder(ids);
  if (!result.ok) return { ok: false, error: result.error ?? "Could not save that order." };
  refresh();
  return { ok: true, notice: result.notice };
}

export async function setAgentPinsAction(
  _prev: AdminResult,
  formData: FormData,
): Promise<AdminResult> {
  if (!(await requireAdmin())) return { ok: false, error: "Admins only." };
  const id = String(formData.get("id") ?? "").trim();
  const pins: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("pin:") && typeof value === "string") {
      pins[key.slice(4)] = value;
    }
  }
  const result = await setAgentPins(id, pins);
  if (!result.ok) return { ok: false, error: result.error ?? "Could not save those pins." };
  refresh();
  return { ok: true, notice: result.notice };
}

/* ————————————————————————— health: test, then arrange ————————————————————————— */

export type TestOutcome = {
  providerId: string;
  label: string;
  models: { model: string; ok: boolean; ms: number; status: number; detail?: string }[];
  best: number | null;
};

/** Probe every model of every enabled provider (or of one provider), measure
    what comes back, and write it to the catalog.

    Bounded on all three axes, because this runs inside one serverless request:
    a small number of models per provider, a short cap per probe (a health check
    that has not answered in twelve seconds is a failure the operator should
    see), and a fixed pool of probes in flight — enough parallelism to finish a
    ten-provider sweep inside the function's budget without turning the test
    into a rate-limit generator that makes every provider look broken. */
export async function testProvidersAction(
  _prev: AdminResult,
  formData: FormData,
): Promise<AdminResult> {
  if (!(await requireAdmin())) return { ok: false, error: "Admins only." };

  const one = String(formData.get("id") ?? "").trim();
  const platform = await getPlatformData();
  const targets = platform.providers
    .filter((p) => (one ? p.id === one : p.enabled))
    /* Never probe a provider with no key: the failure would be about the
       configuration, and calling it "down" would be a lie on the dashboard. */
    .filter((p) => Boolean(p.keyEncrypted) || Boolean(p.keyEnv && process.env[p.keyEnv]?.trim()))
    .slice(0, 12);

  if (targets.length === 0) {
    return {
      ok: false,
      error: one
        ? "That provider has no key, so there is nothing to probe."
        : "No enabled provider has a key yet — add one first.",
    };
  }

  const probeTimeoutMs = 12_000;
  const modelsPerProvider = 4;
  const inFlight = 5;

  const jobs: { provider: (typeof targets)[number]; model: string }[] = [];
  for (const provider of targets) {
    for (const model of provider.models.slice(0, modelsPerProvider)) {
      jobs.push({ provider, model });
    }
  }

  const results = new Map<string, { model: string; ok: boolean; ms: number; status: number; detail?: string }[]>();
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const job = jobs[index];
      if (!job) return;

      const provider = job.provider;
      const apiKey = provider.keyEncrypted
        ? (decryptSecret(provider.keyEncrypted) ?? "")
        : (process.env[provider.keyEnv ?? ""] ?? "").trim();
      if (!apiKey) continue;

      let probed: ProbeResult;
      try {
        probed = await probeModel(
          { id: provider.id, label: provider.label, baseUrl: provider.baseUrl, apiKey },
          job.model,
          probeTimeoutMs,
        );
      } catch (error) {
        probed = {
          ok: false,
          status: 0,
          ms: 0,
          tokens: 0,
          detail: error instanceof Error ? error.message : String(error),
        };
      }

      const rows = results.get(provider.id) ?? [];
      rows.push({ model: job.model, ok: probed.ok, ms: probed.ms, status: probed.status, detail: probed.detail });
      results.set(provider.id, rows);
    }
  }

  await Promise.all(Array.from({ length: Math.min(inFlight, jobs.length) }, () => worker()));

  const summary: string[] = [];
  const at = new Date().toISOString();

  for (const provider of targets) {
    const rows = results.get(provider.id);
    if (!rows || rows.length === 0) continue;

    await saveHealth(
      provider.id,
      Object.fromEntries(rows.map((r) => [r.model, { ...r, at }])),
    );

    const working = rows.filter((r) => r.ok).length;
    const fastest = rows.filter((r) => r.ok).sort((a, b) => a.ms - b.ms)[0];
    summary.push(
      `${provider.label}: ${working}/${rows.length} answered${fastest ? `, fastest ${fastest.model} at ${fastest.ms}ms` : ""}`,
    );
  }

  refresh();
  return { ok: true, notice: summary.join(" · ") || "Nothing to test." };
}

/** The health map, as the panel needs it: per model, with the answer and the
    round-trip. Kept separate from the action so the page can render what the
    last test recorded without re-running one. */
export async function providerHealth(): Promise<Record<string, { at: string; best: number | null; models: Record<string, { ok: boolean; ms: number; status: number; detail?: string }> }>> {
  if (!(await requireAdmin())) return {};
  const platform = await getPlatformData();
  return platform.health ?? {};
}

export async function autoArrangeAction(): Promise<AdminResult> {
  if (!(await requireAdmin())) return { ok: false, error: "Admins only." };
  const result = await autoArrange();
  if (!result.ok) return { ok: false, error: result.error ?? "Could not arrange the catalog." };
  refresh();
  return { ok: true, notice: result.notice };
}

/* ————————————————————————— platform policy and infra ————————————————————————— */

export async function setPolicyAction(_prev: AdminResult, formData: FormData): Promise<AdminResult> {
  if (!(await requireAdmin())) return { ok: false, error: "Admins only." };

  const free = String(formData.get("free") ?? "");
  const pro = String(formData.get("pro") ?? "");
  if (!["free", "premium"].includes(free) || !["free", "premium"].includes(pro)) {
    return { ok: false, error: "Each plan routes to either the free or the premium catalog." };
  }

  await updatePlatformData((current) => ({
    ...current,
    policy: { free: free as ModelTier, pro: pro as ModelTier },
  }));
  refresh();
  return { ok: true, notice: `Policy saved — Free runs on the ${free} catalog, Pro on the ${pro} catalog.` };
}

export async function setInfraAction(_prev: AdminResult, formData: FormData): Promise<AdminResult> {
  const admin = await requireAdmin();
  if (!admin) return { ok: false, error: "Admins only." };

  const { encryptSecret } = await import("@/lib/crypto");
  const github = String(formData.get("githubToken") ?? "").trim();
  const vercel = String(formData.get("vercelToken") ?? "").trim();
  const teamId = String(formData.get("vercelTeamId") ?? "").trim();

  await updatePlatformData((current) => ({
    ...current,
    infra: {
      githubTokenEncrypted: github ? encryptSecret(github) : current.infra.githubTokenEncrypted,
      vercelTokenEncrypted: vercel ? encryptSecret(vercel) : current.infra.vercelTokenEncrypted,
      vercelTeamId: teamId || current.infra.vercelTeamId,
    },
  }));
  refresh();
  return {
    ok: true,
    notice: `Infrastructure saved — ${github || vercel ? "new token(s) stored encrypted" : "team id updated"}.`,
  };
}

/* ————————————————————————— accounts ————————————————————————— */

/** Everything an operator can do to one account, from its row in the panel. */
export async function updateAccountAction(
  _prev: AdminResult,
  formData: FormData,
): Promise<AdminResult> {
  if (!(await requireAdmin())) return { ok: false, error: "Admins only." };

  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { ok: false, error: "No account given." };

  const [target] = await db
    .select({ id: users.id, email: users.email, plan: users.plan, suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!target) return { ok: false, error: "That account no longer exists." };

  const planRaw = String(formData.get("plan") ?? "").trim();
  const suspendRaw = String(formData.get("suspended") ?? "").trim();
  const adjustmentRaw = String(formData.get("adjustment") ?? "").trim();

  const notes: string[] = [];

  if (planRaw && planRaw !== target.plan) {
    if (!["free", "pro"].includes(planRaw)) return { ok: false, error: "Plan must be free or pro." };
    await db.update(users).set({ plan: planRaw as PlanId }).where(eq(users.id, id));
    notes.push(`plan → ${planRaw}`);
  }

  if (suspendRaw === "true" && !target.suspendedAt) {
    await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, id));
    notes.push("suspended");
  }
  if (suspendRaw === "false" && target.suspendedAt) {
    await db.update(users).set({ suspendedAt: null }).where(eq(users.id, id));
    notes.push("reinstated");
  }

  if (adjustmentRaw) {
    const amount = Number(adjustmentRaw);
    if (!Number.isFinite(amount) || amount === 0) {
      return { ok: false, error: "A balance adjustment must be a non-zero number." };
    }
    const { balanceMilli } = await grantCredits(id, Math.round(amount * 1000), "adjust:admin");
    notes.push(`balance → $${(balanceMilli / 1000).toFixed(2)}`);
  }

  refresh();
  return {
    ok: true,
    notice: notes.length > 0 ? `${target.email}: ${notes.join(", ")}.` : `${target.email}: nothing changed.`,
  };
}

export async function deleteAccountAction(
  _prev: AdminResult,
  formData: FormData,
): Promise<AdminResult> {
  const admin = await requireAdmin();
  if (!admin) return { ok: false, error: "Admins only." };

  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { ok: false, error: "No account given." };
  if (admin.userId && id === admin.userId) {
    return { ok: false, error: "You cannot delete the account you are signed in as." };
  }

  const [target] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!target) return { ok: false, error: "That account no longer exists." };
  if (isAdminEmail(target.email)) return { ok: false, error: "That address is an operator — delete it from the environment list instead." };

  /* Deleting the account row cascades to sessions, credit events and runs in
     the schema, which is the honest thing: an account with no owner should not
     leave live projects behind it. */
  await db.delete(users).where(eq(users.id, id));
  refresh();
  return { ok: true, notice: `${target.email} deleted, with its runs and ledger rows.` };
}

/* ————————————————————————— runs ————————————————————————— */

/** Stop any run, whoever owns it. The owner's own Stop button is the same
    path; this is the operator's version of it. */
export async function adminStopRunAction(
  _prev: AdminResult,
  formData: FormData,
): Promise<AdminResult> {
  if (!(await requireAdmin())) return { ok: false, error: "Admins only." };

  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { ok: false, error: "No run given." };

  const [run] = await db
    .select({ id: runs.id, runNumber: runs.runNumber, status: runs.status })
    .from(runs)
    .where(eq(runs.id, id))
    .limit(1);
  if (!run) return { ok: false, error: "That run no longer exists." };
  if (run.status === "done" || run.status === "failed" || run.status === "cancelled") {
    return { ok: false, error: `Run #${run.runNumber} already ended.` };
  }

  await cancelQueuedForRun(id);
  await db
    .update(runs)
    .set({ status: "cancelled", error: "Cancelled by an operator.", completedAt: new Date() })
    .where(eq(runs.id, id));
  await logEvent(id, "orchestrator", "warn", "cancelled by an operator");
  refresh();
  return { ok: true, notice: `Run #${run.runNumber} stopped.` };
}

/** Find an account by email fragment, for the panel's search box. */
export async function searchAccounts(term: string): Promise<{ id: string; email: string | null; name: string | null }[]> {
  if (!(await requireAdmin())) return [];
  const needle = term.trim();
  if (needle.length < 2) return [];
  return db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(or(ilike(users.email, `%${needle}%`), ilike(users.name, `%${needle}%`)))
    .orderBy(desc(users.createdAt))
    .limit(8);
}

/** Spend per account: runs started, tokens burned, credits charged — the three
    numbers an operator checks before deciding whether to top someone up. */
export async function accountUsage(): Promise<
  { userId: string; runs: number; tokens: number }[]
> {
  if (!(await requireAdmin())) return [];
  const rows = await db
    .select({
      userId: runs.userId,
      runs: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(${runs.tokens}), 0)::int`,
    })
    .from(runs)
    .groupBy(runs.userId);
  return rows;
}

