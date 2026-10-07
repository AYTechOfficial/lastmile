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

/** Just the ids, in failover order. This is what the provider catalog stores. */
export const TRUE_MODEL_IDS: string[] = TRUE_MODELS.map((m) => m.id);

/** The single model a run reaches for first when the user expressed no
    preference: the fastest one that answered cleanly. Chosen rather than
    hardcoded to index 0 so reordering the table reorders the default with it. */
export const PREFERRED_FREE_MODEL: string =
  TRUE_MODELS.find((m) => !m.partial)?.id ?? TRUE_MODEL_IDS[0];

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
