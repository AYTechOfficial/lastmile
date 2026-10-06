"use client";

import { useState, useTransition } from "react";
import { ArrowUpRight, Check, Cpu } from "lucide-react";
import { addUserProviderAction, deleteUserProviderAction, toggleUserProviderAction } from "@/app/actions/settings";
import { Badge, btn } from "@/components/kit";
import type { SafeUserProvider } from "@/lib/platform/user-providers";

/* Settings → Your providers. One click on a preset fills in the base URL, the
   user pastes their key, we list what the endpoint serves, and every model
   starts selected — tap the ones to drop, add, done. Keys typed here are sent
   only to the discovery endpoint, then stored server-side encrypted — they are
   never echoed back in plaintext. */

const input =
  "w-full rounded-lg border border-edge bg-surface2/40 px-3 py-2 text-[13px] text-t1 outline-none transition-colors placeholder:text-t3 focus:border-brand";

const PRESETS: { label: string; baseUrl: string; keysUrl: string; hint: string }[] = [
  {
    label: "ChatGPT",
    baseUrl: "https://api.openai.com/v1",
    keysUrl: "https://platform.openai.com/api-keys",
    hint: "OpenAI API — GPT-5 family",
  },
  {
    label: "Claude",
    baseUrl: "https://api.anthropic.com/v1",
    keysUrl: "https://console.anthropic.com/settings/keys",
    hint: "Anthropic API — Sonnet & Haiku",
  },
  {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keysUrl: "https://openrouter.ai/settings/keys",
    hint: "one key, every model — has free tiers",
  },
  {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keysUrl: "https://console.groq.com/keys",
    hint: "very fast open models",
  },
  {
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    keysUrl: "https://cloud.cerebras.ai",
    hint: "fast inference, free tier",
  },
  {
    label: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keysUrl: "https://build.nvidia.com",
    hint: "NIM endpoints — free credits",
  },
];

export function UserProviders({ providers }: { providers: SafeUserProvider[] }) {
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [available, setAvailable] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, start] = useTransition();

  const picked = (m: string) => selected.includes(m);
  const toggleModel = (m: string) =>
    setSelected((s) => (s.includes(m) ? s.filter((x) => x !== m) : [...s, m].sort()));

  function applyPreset(p: (typeof PRESETS)[number]) {
    setLabel(p.label + " (mine)");
    setBaseUrl(p.baseUrl);
    setAvailable([]);
    setSelected([]);
    setError(null);
  }

  async function discover() {
    setError(null);
    setAvailable([]);
    setSelected([]);
    if (!baseUrl.trim()) return setError("Pick a preset or enter a base URL first");
    setBusy(true);
    try {
      const res = await fetch("/api/providers/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() }),
      });
      const j = (await res.json()) as { models?: string[]; error?: string };
      if (!res.ok) setError(j.error ?? "Could not list models");
      else {
        setAvailable(j.models ?? []);
        setSelected(j.models ?? []);
        if (!j.models?.length) setError("The endpoint listed no models");
      }
    } catch {
      setError("Could not reach the endpoint");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* quick connect — one tap fills the base URL, paste your key and go */}
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => applyPreset(p)}
            title={p.hint + " — " + p.baseUrl}
            className={
              "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors " +
              (baseUrl === p.baseUrl
                ? "border-brand/50 bg-brand/12 text-brand"
                : "border-edge bg-surface2 text-t2 hover:border-edge2 hover:text-t1")
            }
          >
            <Cpu className="h-3 w-3 opacity-70" />
            {p.label}
            <a
              href={p.keysUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={"Get a " + p.label + " key"}
              className="ml-0.5 rounded-full p-0.5 text-t3 transition-colors hover:text-brand"
            >
              <ArrowUpRight className="h-3 w-3" />
            </a>
          </button>
        ))}
      </div>

      {providers.length > 0 && (
        <div className="space-y-2">
          {providers.map((p) => (
            <div key={p.id} className="flex items-start gap-3 rounded-lg border border-edge bg-surface2/30 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13.5px] font-medium text-t1">{p.label}</span>
                  <Badge tone={p.enabled ? "pass" : "warn"}>{p.enabled ? "on" : "off"}</Badge>
                </div>
                <p className="mt-0.5 truncate text-[11.5px] text-t3">{p.baseUrl}</p>
                <p className="mt-0.5 text-[11.5px] text-t3">
                  key {p.keyMask} · {p.models.length} model{p.models.length === 1 ? "" : "s"}
                </p>
                {p.models.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {p.models.slice(0, 8).map((m) => (
                      <span
                        key={m}
                        className="rounded-full border border-edge bg-surface2 px-2 py-0.5 font-mono text-[9.5px] text-t3"
                      >
                        {m}
                      </span>
                    ))}
                    {p.models.length > 8 && (
                      <span className="rounded-full border border-edge bg-surface2 px-2 py-0.5 font-mono text-[9.5px] text-t3">
                        +{p.models.length - 8} more
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-1.5">
                <form action={toggleUserProviderAction}>
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit" className={btn("outline", "sm")}>{p.enabled ? "Turn off" : "Turn on"}</button>
                </form>
                <form action={deleteUserProviderAction}>
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit" className={btn("ghost", "sm")}>Remove</button>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}

      <form
        action={async (fd) => {
          if (selected.length === 0) return setError("Select at least one model (or paste ids manually below)");
          fd.set("models", selected.join(","));
          start(async () => {
            await addUserProviderAction(fd);
            setApiKey("");
            setAvailable([]);
            setSelected([]);
          });
        }}
        className="space-y-2.5 rounded-lg border border-edge p-3"
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <input name="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label — e.g. My OpenRouter" className={input} />
          <input name="baseUrl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL — prefilled by a preset" className={input} />
        </div>
        <input name="apiKey" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API key" type="password" className={input} />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={discover} disabled={busy} className={btn("outline", "sm")}>
            {busy ? "Listing…" : "Fetch models"}
          </button>
          {available.length > 0 && (
            <>
              <button type="button" onClick={() => setSelected(available)} className={btn("ghost", "sm")}>
                Select all
              </button>
              <button type="button" onClick={() => setSelected([])} className={btn("ghost", "sm")}>
                Clear
              </button>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-t3">
                {selected.length}/{available.length} selected
              </span>
            </>
          )}
          {available.length === 0 && (
            <span className="text-[11.5px] text-t3">lists what the endpoint serves — every model starts selected</span>
          )}
        </div>
        {error && <p className="text-[11.5px] text-bad">{error}</p>}
        {available.length > 0 && (
          <div className="flex max-h-52 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-edge bg-surface2/30 p-2.5 thin-scroll">
            {available.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => toggleModel(m)}
                className={
                  "flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[10.5px] transition-colors " +
                  (picked(m)
                    ? "border-brand/40 bg-brand/12 text-brand"
                    : "border-edge bg-surface2 text-t3 hover:text-t2")
                }
              >
                {picked(m) && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                {m}
              </button>
            ))}
          </div>
        )}
        <details className="group">
          <summary className="cursor-pointer select-none text-[11px] text-t3 transition-colors hover:text-t2">
            advanced — type model ids manually
          </summary>
          <textarea
            value={selected.join(", ")}
            onChange={(e) => {
              const ids = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
              setSelected(ids);
              setAvailable((a) => (ids.length > a.length ? [...new Set([...a, ...ids.filter((i) => !a.includes(i))])] : a));
            }}
            rows={3}
            placeholder="model ids, comma separated"
            className={input + " mt-2 font-mono text-[11.5px]"}
          />
        </details>
        <button type="submit" disabled={pending} className={btn("brand", "sm", "w-full")}>
          {pending ? "Saving…" : "Add provider"}
        </button>
      </form>
    </div>
  );
}
