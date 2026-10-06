/* Which model providers exist, and whether each has a key.

   This is a *configuration* view for the shell and Settings: it reads the
   platform catalog and reports whether a key would resolve. It deliberately
   does not decrypt anything, does not call a provider, and does not import the
   chat client — so the dashboard can render it without pulling the model layer
   into the server render graph.

   Asynchrony is the honest part: the catalog lives in Postgres (the operator
   edits it), not in the environment, so this cannot be a synchronous env scan
   the way the previous build's version was. */

import { getPlatformData, type ProviderEntry } from "../platform/settings";

export type ProviderDef = {
  id: string;
  label: string;
  /** what this rung costs to use, shown in the capacity list */
  freeTier: string;
  baseUrl: string;
  models: string[];
  tier: string;
  /** the env var an env-configured provider reads, so Settings can show where
      to paste a key; null when the key lives only in the admin catalog */
  keyEnv: string | null;
  /** where to get a key, when we know it — null hides the link rather than
      guessing */
  signupUrl: string | null;
};

export type ProviderState = {
  def: ProviderDef;
  /** a key is present, so this provider would answer a call */
  configured: boolean;
  /** the model it answers with by default */
  model?: string;
};

/** Where a key comes from, for the providers we ship with. Deliberately a
    map and not a guess built from baseUrl: an API host is not a signup page. */
const SIGNUP: Record<string, string> = {
  groq: "https://console.groq.com/keys",
  gemini: "https://aistudio.google.com/apikey",
  nvidia: "https://build.nvidia.com/",
  nim: "https://build.nvidia.com/",
  cerebras: "https://cloud.cerebras.ai/",
  openrouter: "https://openrouter.ai/settings/keys",
};

/** Would this provider accept a request? An admin-entered key counts even
    without an env var, and vice versa — either is a real credential. */
function hasKey(p: ProviderEntry): boolean {
  if (p.keyEncrypted) return true;
  return Boolean(p.keyEnv?.trim() && process.env[p.keyEnv]?.trim());
}

export async function providerStates(): Promise<ProviderState[]> {
  const platform = await getPlatformData();

  return platform.providers
    .filter((p) => p.enabled)
    .map((p) => ({
      def: {
        id: p.id,
        label: p.label,
        freeTier: p.notes ?? (p.tier === "free" ? "free tier" : "premium tier"),
        baseUrl: p.baseUrl,
        models: p.models,
        tier: p.tier,
        keyEnv: p.keyEnv ?? null,
        signupUrl: SIGNUP[p.id] ?? null,
      },
      configured: hasKey(p),
      model: p.models[0],
    }));
}

/** The model ids one provider exposes — used by Settings' per-agent pins. */
export async function modelIdsFor(providerId: string): Promise<string[]> {
  const platform = await getPlatformData();
  return platform.providers.find((p) => p.id === providerId)?.models ?? [];
}
