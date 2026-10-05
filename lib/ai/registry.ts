import type { ChatOptions, ChatResult, ChatMessage } from "./providers";
import { chatWith, providerStates } from "./providers";
import { getPlatformData, resolveProviders, type AgentId, type PlanId } from "@/lib/platform/settings";
import { activeUserProviders } from "@/lib/platform/user-providers";
import { currentUserId } from "./context";

/* Model registry — decides which endpoint each agent talks to.

   Resolution order for (agent, plan):
     1. The signed-in user's OWN providers (Settings → Your providers) scoped
        to that agent — a key they pay for wins.
     2. Admin-configured platform providers scoped to that plan (and that
        agent when the entry is agent-specific), in the operator's order.
     3. The env-key chain from providers.ts (free tiers), in chain order.

   Returns a chat() bound to the resolved chain so every agent call site is a
   one-liner that still reports which provider actually answered. */

export type ResolvedChain = {
  providers: { id: string; label: string; baseUrl: string; apiKey: string; models: string[] }[];
  /** human-readable summary for logs, e.g. "own:My endpoint → admin:Groq-70b → env:Gemini" */
  summary: string;
  source: "user" | "admin" | "env" | "none";
};

export async function resolveChain(plan: PlanId, agent: AgentId): Promise<ResolvedChain> {
  const userId = currentUserId();

  // 1) the user's own endpoints, in the order they added them — scoped to the
  //    agent so a provider pinned to one agent never leaks into another.
  const own = userId
    ? (await activeUserProviders(userId))
        .filter((p) => p.models.length > 0)
        .map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseUrl, apiKey: p.apiKey, models: p.models }))
    : [];

  const data = await getPlatformData();
  // keep the admin's ordering, but only entries this (plan, agent) may use:
  // a provider reserved for one agent never leaks into another agent's chain.
  const allowedIds = new Set(
    data.providers
      .filter((p) => p.agent === null || p.agent === agent)
      .map((p) => p.id),
  );
  const admin = await resolveProviders(plan);
  const scoped = admin.filter((p) => p.models.length > 0 && allowedIds.has(p.id));

  // The env-key chain is ALWAYS part of the chain: admin entries are added in
  // front of it, not a replacement for it. A provider that is configured and
  // paid for must never be unreachable just because another one exists — this
  // is also the natural failover when the first entry truncates a response.
  const env = providerStates()
    .filter((p) => p.configured)
    .map((p) => {
      // a per-agent pin replaces the provider's default model order for that
      // agent only — e.g. NIM runs the coder on its coding specialist
      const pinned = p.def.modelsByAgent?.[agent];
      const models = pinned?.length ? pinned : [p.model, ...p.def.models];
      return {
        id: p.def.id,
        label: p.def.label,
        baseUrl: p.def.baseUrl,
        apiKey: process.env[p.def.keyEnv]!.trim(),
        models: models.filter((m, i, a) => a.indexOf(m) === i),
      };
    });

  const providers = [...own, ...scoped, ...env];
  if (providers.length > 0) {
    const parts = [];
    if (own.length > 0) parts.push("own: " + own.map((p) => p.label).join(" → "));
    if (scoped.length > 0) parts.push("admin: " + scoped.map((p) => p.label).join(" → "));
    if (env.length > 0) parts.push("env: " + env.map((p) => p.label).join(" → "));
    return { providers, summary: parts.join(" → "), source: own.length > 0 ? "user" : scoped.length > 0 ? "admin" : "env" };
  }

  return { providers: [], summary: "none configured", source: "none" };
}

/** A chat() scoped to the chain this agent+plan should use. */
export async function agentChat(
  plan: PlanId,
  agent: AgentId,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult & { chain: string }> {
  const chain = await resolveChain(plan, agent);
  if (chain.providers.length === 0) {
    // keep the message honest — the caller decides whether to degrade or fail
    throw new Error("no model providers available for plan '" + plan + "' — add a key in Admin → Providers or .env.local");
  }
  const res = await chatWith(chain.providers, messages, opts);
  return { ...res, chain: chain.summary };
}
