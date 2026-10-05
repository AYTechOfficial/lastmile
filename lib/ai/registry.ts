import type { ChatOptions, ChatResult, ChatMessage } from "./providers";
import { chatWith, providerStates } from "./providers";
import { getPlatformData, resolveProviders, type AgentId, type PlanId } from "@/lib/platform/settings";

/* Model registry — decides which endpoint each agent talks to.

   Resolution order for (agent, plan):
     1. Admin-configured providers scoped to that plan (and that agent when
        the entry is agent-specific) — tried in the order the admin ordered them.
     2. The env-key chain from providers.ts (free tiers), in chain order.

   Returns a chat() bound to the resolved chain so every agent call site is a
   one-liner that still reports which provider actually answered. */

export type ResolvedChain = {
  providers: { id: string; label: string; baseUrl: string; apiKey: string; models: string[] }[];
  /** human-readable summary for logs, e.g. "admin:Groq-70b → env:Gemini" */
  summary: string;
  source: "admin" | "env" | "none";
};

export async function resolveChain(plan: PlanId, agent: AgentId): Promise<ResolvedChain> {
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

  const providers = [...scoped, ...env];
  if (providers.length > 0) {
    return {
      providers,
      summary:
        (scoped.length > 0 ? "admin: " + scoped.map((p) => p.label).join(" → ") : "") +
        (scoped.length > 0 && env.length > 0 ? " → " : "") +
        (env.length > 0 ? "env: " + env.map((p) => p.label).join(" → ") : ""),
      source: scoped.length > 0 ? "admin" : "env",
    };
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
