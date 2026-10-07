/* The free model catalog — measured, not guessed.

   Every entry below was benchmarked against the provider's own endpoint with a
   fixed one-sentence prompt, and the numbers recorded next to it are what that
   benchmark actually reported: median wall-clock latency, and output tokens per
   second. Entries are ordered by throughput, fastest first, because that order
   *is* the failover order — a run that has to fall through three rungs should
   fall through the quick ones before it reaches the slow ones.

   Two things are deliberately excluded:

     · Models that failed the probe (timeouts, 429s, "no available channel",
       quota exhausted, retired ids). A model that cannot answer a one-line
       prompt will not survive a coding pipeline, and listing it would just add
       a guaranteed stall to every run that reached it.
     · Models that are not chat models at all (an OCR model answered the probe
       happily and is still not something a pipeline can plan with).

   `partial` marks a model whose reply was truncated or whose identity probe was
   inconclusive. Those still answered, so they stay — but ranked below the
   models that answered cleanly, and flagged so the operator can see why.

   This list is the *default*. The admin catalog in Postgres overrides it, so
   the order can change without a deploy. */

export type CatalogModel = {
  id: string;
  /** measured output tokens/second on the probe prompt */
  tps: number;
  /** measured latency of the probe request, in milliseconds */
  latencyMs: number;
  /** true when the probe reply was truncated or the identity check inconclusive */
  partial?: boolean;
};

/** Measured 2026-10-07 against https://1412520.bond/v1 — 30 models probed. */
export const TRUE_MODELS: CatalogModel[] = [
  { id: "gemini-2.5-flash", tps: 74.9, latencyMs: 801 },
  { id: "qwen3.7-flash-2026-07-15", tps: 70.8, latencyMs: 5720 },
  { id: "qwen3.7-flash", tps: 57.2, latencyMs: 5470 },
  { id: "gemini-3.6-flash", tps: 48.8, latencyMs: 1230 },
  { id: "qwen3.8-27b", tps: 40.8, latencyMs: 1570, partial: true },
  { id: "gpt-oss-20b", tps: 36.2, latencyMs: 1770 },
  { id: "qwen3.8-flash-next", tps: 29.3, latencyMs: 1710 },
  { id: "hy3", tps: 16.9, latencyMs: 3780, partial: true },
  { id: "gemini-3.7-flash", tps: 13.5, latencyMs: 4520, partial: true },
  { id: "glm-5.3-flash", tps: 12.5, latencyMs: 3600 },
  { id: "hy4-preview-f", tps: 11.8, latencyMs: 5410, partial: true },
  { id: "gemini-3.5-flash-lite", tps: 10.2, latencyMs: 489 },
  { id: "qwen-3.8-flash-next", tps: 9.9, latencyMs: 4050 },
  { id: "minimax-m3", tps: 9.1, latencyMs: 2190 },
  { id: "step-3.7-flash", tps: 6.8, latencyMs: 9360, partial: true },
  { id: "gemini-3.5-flash", tps: 3.4, latencyMs: 17800 },
  { id: "deepseek-v4.1-flash", tps: 3.3, latencyMs: 3300 },
  { id: "gemini-3.8-flash", tps: 2.5, latencyMs: 24000 },
  { id: "deepseek-v4-flash", tps: 1.6, latencyMs: 1880 },
  { id: "glm-5.3", tps: 0.8, latencyMs: 52700 },
  { id: "gpt-5.6", tps: 0.5, latencyMs: 5930 },
];

/** Measured 2026-10-07 against https://api.hcnsec.cn/v1 — 21 models listed,
    14 probed as chat models, 10 answered with real text (the rest: 404 "model
    is not found", 500 "no available channel", or a timeout). The thinking
    models need an uncapped reply budget — with a small `max_tokens` they spend
    it all reasoning and return empty content, so the ordering below puts the
    models that answer plainly first and flags the thinkers `partial`. */
export const HCNSEC_MODELS: CatalogModel[] = [
  { id: "DeepSeek-V4-Pro", tps: 5.6, latencyMs: 1439 },
  { id: "DeepSeek-V4-Flash", tps: 3.7, latencyMs: 2151 },
  { id: "MiMo-V2.6-Flash", tps: 2.1, latencyMs: 3852 },
  { id: "Qwen3.8-Flash-Next", tps: 1.7, latencyMs: 4547 },
  { id: "step-5-preview", tps: 1.4, latencyMs: 3217, partial: true },
  { id: "Qwen3.8-27B", tps: 1.3, latencyMs: 4929, partial: true },
  { id: "sensenova-6.8-flash-lite", tps: 1.1, latencyMs: 3159, partial: true },
  { id: "DeepSeek-V4.1-Flash", tps: 0.4, latencyMs: 10254, partial: true },
  { id: "longcat-2.5", tps: 0.2, latencyMs: 14302, partial: true },
  { id: "glm-5.3-flash", tps: 0.2, latencyMs: 14244, partial: true },
];

/** Measured 2026-10-07 against https://api.aionlabs.ai/v1 — 6 models listed;
    the five chat models all answered. The sixth (aion-rp-llama-3.1-8b) is a
    roleplay model, not something a build pipeline can plan with, and is left
    out of the chain for the same reason the OCR model is. */
export const AION_MODELS: CatalogModel[] = [
  { id: "aion-labs/aion-3.0", tps: 4.4, latencyMs: 1360 },
  { id: "aion-labs/aion-3.0-mini", tps: 4.3, latencyMs: 1382 },
  { id: "aion-labs/aion-3.5-mini", tps: 4.2, latencyMs: 1433 },
  { id: "aion-labs/aion-3.5", tps: 3.8, latencyMs: 1470 },
  { id: "aion-labs/aion-2.0", tps: 2.1, latencyMs: 2150 },
];

/** Just the ids, in failover order. This is what the provider catalog stores.

    The retired set is a fact learned from the provider, not from the probe:
    gemini-2.5-flash measured fastest on 2026-10-07 and answered 404 the very
    next day ("no longer available to new users"). A catalog that lists a model
    the provider will not serve spends a rung on every call to prove it. */
const RETIRED = new Set<string>(["gemini-2.5-flash"]);

export const TRUE_MODEL_IDS: string[] = TRUE_MODELS.filter((m) => !RETIRED.has(m.id)).map((m) => m.id);
export const HCNSEC_MODEL_IDS: string[] = HCNSEC_MODELS.map((m) => m.id);
export const AION_MODEL_IDS: string[] = AION_MODELS.map((m) => m.id);

/** The single model a run reaches for first when the user expressed no
    preference.

    Two gates, both learned the hard way: the model must not be retired, and it
    must have real throughput (>= 40 t/s) — otherwise the fastest *first token*
    would pick a trickle, and a trickle writing a 400-line file holds the whole
    stage open. Among the models that clear both, latency decides, because that
    is what the run log is measured in: gemini-3.6-flash answered in 7–18s where
    the higher-throughput qwen3.7 variants took 78–143s wall clock. */
export const PREFERRED_FREE_MODEL: string =
  TRUE_MODELS.filter((m) => !m.partial && !RETIRED.has(m.id) && m.tps >= 40)
    .sort((a, b) => a.latencyMs - b.latencyMs)[0]?.id ??
  TRUE_MODEL_IDS[0] ??
  TRUE_MODELS[0]?.id ??
  "";

/** Human-readable one-liner for the run-start picker. */
export function describeModel(m: CatalogModel): string {
  const speed = m.tps >= 1 ? `${Math.round(m.tps)} t/s` : "<1 t/s";
  const latency = m.latencyMs < 1000 ? `${m.latencyMs}ms` : `${(m.latencyMs / 1000).toFixed(1)}s`;
  return `${latency} · ${speed}${m.partial ? " · partial" : ""}`;
}

/** Which provider the free-tier catalog above belongs to. Kept beside the
    measurements so the host and the numbers that came from it cannot drift. */
export const TRUE_PROVIDER = {
  id: "truemodel",
  label: "1412 (TrueModel)",
  baseUrl: "https://1412520.bond/v1",
  keyEnv: "TRUEMODEL_API_KEY",
  notes: "21 of 30 models verified working; ordered by measured throughput",
} as const;

export const HCNSEC_PROVIDER = {
  id: "hcnsec",
  label: "HCNSEC",
  baseUrl: "https://api.hcnsec.cn/v1",
  keyEnv: "HCNSEC_API_KEY",
  notes: "10 of 14 chat models verified; carries DeepSeek, GLM, Qwen and Step models",
} as const;

export const AION_PROVIDER = {
  id: "aionlabs",
  label: "Aion Labs",
  baseUrl: "https://api.aionlabs.ai/v1",
  keyEnv: "AION_API_KEY",
  notes: "5 of 5 chat models verified; uncensored, unrestricted models",
} as const;
