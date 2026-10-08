"use client";

import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  Check,
  ChevronDown,
  GripVertical,
  Loader2,
  Pencil,
  Play,
  Power,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Badge, Panel, btn } from "@/components/kit";
import { saveAdminCredentialsAction } from "@/app/actions/admin-auth";
import {
  adminStopRunAction,
  autoArrangeAction,
  deleteAccountAction,
  deleteProviderAction,
  grantCreditsAction,
  reorderProvidersAction,
  saveProviderAction,
  setAgentPinsAction,
  setCreditPricingAction,
  setInfraAction,
  setPolicyAction,
  testProvidersAction,
  toggleProviderAction,
  updateAccountAction,
  type AdminResult,
} from "@/app/actions/admin";
import type { AgentId, CatalogHealth, ProviderEntry } from "@/lib/platform/settings";
import type { ProviderPreset } from "@/lib/platform/catalog";

const inputCls =
  "w-full rounded-[10px] border border-edge bg-well px-3.5 py-2.5 text-[13.5px] text-t1 outline-none transition-colors placeholder:text-t3 focus:border-brand/60";

function Result({ state }: { state: { error?: string; notice?: string } }) {
  if (state.error) {
    return (
      <p role="alert" className="flex items-start gap-2 text-[12px] text-bad">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {state.error}
      </p>
    );
  }
  if (state.notice) {
    return (
      <p role="status" className="flex items-start gap-2 text-[12px] text-pass">
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {state.notice}
      </p>
    );
  }
  return null;
}

/* ————————————————————————— credit economy ————————————————————————— */

export function CreditPricingForm({
  pricePerMillion,
  freeGrant,
}: {
  pricePerMillion: number;
  freeGrant: number;
}) {
  const [state, action, pending] = useActionState(setCreditPricingAction, { ok: false });
  return (
    <form action={action} className="space-y-3.5">
      <p className="text-[13px] font-medium text-t1">Pricing</p>
      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">Price per 1M tokens ($)</span>
        <input
          type="number"
          name="pricePerMillion"
          step="0.01"
          min="0"
          max="1000"
          defaultValue={pricePerMillion.toFixed(2)}
          required
          className={inputCls}
        />
        <span className="mt-1 block text-[11px] text-t3">
          100 tokens of a run at $1.00/M costs $0.0001 — charges round up to $0.001.
        </span>
      </label>
      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">New-account grant ($)</span>
        <input
          type="number"
          name="freeGrant"
          step="0.01"
          min="0"
          max="1000"
          defaultValue={freeGrant.toFixed(2)}
          required
          className={inputCls}
        />
      </label>
      <div className="flex items-center justify-between gap-3">
        <Result state={state} />
        <button type="submit" disabled={pending} className={btn("brand", "sm", "ml-auto")}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save pricing
        </button>
      </div>
    </form>
  );
}

export function CreditGrantForm() {
  const [state, action, pending] = useActionState(grantCreditsAction, { ok: false });
  return (
    <form action={action} className="space-y-3.5">
      <p className="text-[13px] font-medium text-t1">Adjust a balance by email</p>
      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">Account email</span>
        <input type="email" name="email" required placeholder="user@example.com" className={inputCls} />
      </label>
      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">Amount ($) — negative to claw back</span>
        <input type="number" name="amount" step="0.01" placeholder="5.00" required className={inputCls} />
      </label>
      <div className="flex items-center justify-between gap-3">
        <Result state={state} />
        <button type="submit" disabled={pending} className={btn("outline", "sm", "ml-auto")}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Apply
        </button>
      </div>
    </form>
  );
}

/* ————————————————————————— providers ————————————————————————— */

function healthBadge(ms: number | null, ok: boolean, status: number) {
  if (ok) return <Badge tone="pass">{ms}ms</Badge>;
  return (
    <Badge tone={status === 404 || status === 410 ? "warn" : "bad"}>
      {status === 0 ? "no answer" : `HTTP ${status}`}
    </Badge>
  );
}

/** One provider row: order handle, identity, health, and the controls that
    change whether it is in the chain at all. The editor opens in place —
    a catalog is read and edited in the same glance. */
function ProviderRow({
  provider,
  health,
  presets,
  agents,
}: {
  provider: ProviderEntry;
  health?: CatalogHealth[string];
  presets: ProviderPreset[];
  agents: { id: AgentId; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [saveState, saveAction, saving] = useActionState(saveProviderAction, { ok: false });
  const [pinState, pinAction, pinning] = useActionState(setAgentPinsAction, { ok: false });
  const [toggleState, toggleAction, toggling] = useActionState(toggleProviderAction, { ok: false });
  const [deleteState, deleteAction, deleting] = useActionState(deleteProviderAction, { ok: false });
  const [testState, testAction, testing] = useActionState(testProvidersAction, { ok: false });
  const preset = presets.find((p) => p.id === provider.id);

  const measured = health?.models ?? {};
  const working = Object.values(measured).filter((m) => m.ok).length;

  return (
    <div className="border-b border-edge last:border-0">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <GripVertical className="drag-handle h-4 w-4 shrink-0 cursor-grab text-t3 active:cursor-grabbing" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[13px] font-medium text-t1">{provider.label}</p>
            <Badge tone={provider.tier === "premium" ? "brand" : "neutral"}>{provider.tier}</Badge>
            {!provider.enabled ? <Badge tone="warn">off</Badge> : null}
            {provider.keyEnv && !provider.keyEncrypted ? (
              <span className="font-mono text-[10px] text-t3">{provider.keyEnv}</span>
            ) : null}
          </div>
          <p className="truncate font-mono text-[10.5px] text-t3">
            {provider.models.length} model{provider.models.length === 1 ? "" : "s"} · {provider.baseUrl}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {health ? (
            health.best !== null ? (
              <Badge tone="pass">{health.best}ms</Badge>
            ) : (
              <Badge tone="bad">{working}/{provider.models.length} up</Badge>
            )
          ) : null}
          <form action={toggleAction}>
            <input type="hidden" name="id" value={provider.id} />
            <input type="hidden" name="enabled" value={provider.enabled ? "false" : "true"} />
            <button
              type="submit"
              disabled={toggling}
              title={provider.enabled ? "Disable" : "Enable"}
              className={btn(provider.enabled ? "outline" : "outline", "sm")}
            >
              <Power className={"h-3.5 w-3.5 " + (provider.enabled ? "text-pass" : "text-t3")} />
            </button>
          </form>
          <form action={testAction}>
            <input type="hidden" name="id" value={provider.id} />
            <button type="submit" disabled={testing} title="Probe this provider's models" className={btn("outline", "sm")}>
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            </button>
          </form>
          <button type="button" onClick={() => setOpen((v) => !v)} className={btn("outline", "sm")}>
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <form action={deleteAction}>
            <input type="hidden" name="id" value={provider.id} />
            <button type="submit" disabled={deleting} title="Remove from the catalog" className={btn("outline", "sm")}>
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 text-bad" />}
            </button>
          </form>
        </div>
      </div>

      {toggleState.error || toggleState.notice ? (
        <div className="px-4 pb-2">
          <Result state={toggleState} />
        </div>
      ) : null}
      {deleteState.error || deleteState.notice ? (
        <div className="px-4 pb-2">
          <Result state={deleteState} />
        </div>
      ) : null}
      {testState.error || testState.notice ? (
        <div className="px-4 pb-2">
          <Result state={testState} />
        </div>
      ) : null}

      {open ? (
        <div className="space-y-4 border-t border-edge bg-well/40 px-4 py-4">
          <form action={saveAction} className="grid gap-3 md:grid-cols-2">
            <input type="hidden" name="id" value={provider.id} />
            <label className="block">
              <span className="eyebrow eyebrow-strong mb-1.5 block">Name</span>
              <input name="label" defaultValue={provider.label} required className={inputCls} />
            </label>
            <label className="block">
              <span className="eyebrow eyebrow-strong mb-1.5 block">Base URL</span>
              <input name="baseUrl" defaultValue={provider.baseUrl} required className={inputCls} />
            </label>
            <label className="block md:col-span-2">
              <span className="eyebrow eyebrow-strong mb-1.5 block">Models — one per line, top one first</span>
              <textarea
                name="models"
                defaultValue={provider.models.join("\n")}
                rows={4}
                required
                className={inputCls + " font-mono text-[12px]"}
              />
            </label>
            <label className="block">
              <span className="eyebrow eyebrow-strong mb-1.5 block">Tier</span>
              <select name="tier" defaultValue={provider.tier} className={inputCls}>
                <option value="free">free</option>
                <option value="premium">premium</option>
              </select>
            </label>
            <label className="block">
              <span className="eyebrow eyebrow-strong mb-1.5 block">
                {provider.keyEncrypted ? "Replace key (blank keeps the stored one)" : "API key"}
              </span>
              <input name="apiKey" type="password" autoComplete="off" placeholder={provider.keyEncrypted ? "••••••" : "paste the key"} className={inputCls} />
            </label>
            <label className="block">
              <span className="eyebrow eyebrow-strong mb-1.5 block">…or env var name</span>
              <input name="keyEnv" defaultValue={provider.keyEnv ?? ""} placeholder="GROQ_API_KEY" className={inputCls + " font-mono text-[12px]"} />
            </label>
            <label className="block">
              <span className="eyebrow eyebrow-strong mb-1.5 block">Notes</span>
              <input name="notes" defaultValue={provider.notes ?? ""} placeholder="free tier, 40 req/min" className={inputCls} />
            </label>
            <label className="flex items-center gap-2 md:col-span-2">
              <input type="checkbox" name="enabled" defaultChecked={provider.enabled} className="h-4 w-4" style={{ accentColor: "var(--color-brand, #4f8cff)" }} />
              <span className="text-[12.5px] text-t2">Enabled — this provider is part of the failover chain</span>
            </label>
            <div className="md:col-span-2">
              <Result state={saveState} />
            </div>
            <div className="flex gap-2 md:col-span-2">
              <button type="submit" disabled={saving} className={btn("brand", "sm")}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Save provider
              </button>
              <button type="button" onClick={() => setOpen(false)} className={btn("ghost", "sm")}>
                <X className="h-3.5 w-3.5" /> Close
              </button>
            </div>
          </form>

          {agents.length > 0 ? (
            <form action={pinAction} className="space-y-2 border-t border-edge pt-3">
              <input type="hidden" name="id" value={provider.id} />
              <p className="text-[12.5px] font-medium text-t1">Pin an agent to this provider&apos;s model</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {agents.map((a) => (
                  <label key={a.id} className="block">
                    <span className="eyebrow mb-1 block">{a.label}</span>
                    <select name={`pin:${a.id}`} defaultValue={provider.agents?.[a.id] ?? ""} className={inputCls}>
                      <option value="">— chain decides —</option>
                      {provider.models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <Result state={pinState} />
                <button type="submit" disabled={pinning} className={btn("outline", "sm", "ml-auto")}>
                  {pinning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Save pins
                </button>
              </div>
            </form>
          ) : null}

          {health && Object.keys(health.models).length > 0 ? (
            <div className="space-y-1.5 border-t border-edge pt-3">
              <p className="text-[12.5px] font-medium text-t1">
                Last test — {new Date(health.at).toLocaleString()}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(health.models).map(([model, m]) => (
                  <span key={model} className="inline-flex items-center gap-1.5 rounded-lg border border-edge px-2 py-1">
                    <span className="font-mono text-[10.5px] text-t2">{model}</span>
                    {healthBadge(m.ms, m.ok, m.status)}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {preset ? (
            <p className="text-[11px] text-t3">Preset: {preset.notes}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The whole catalog: draggable rows, Test, Auto-arrange, and the form that
    adds a provider — or starts from a preset and edits before saving. */
export function ProviderCatalog({
  providers,
  health,
  presets,
  agents,
}: {
  providers: ProviderEntry[];
  health: CatalogHealth;
  presets: ProviderPreset[];
  agents: { id: AgentId; label: string }[];
}) {
  /* The arrangement being dragged is local state, but the server's order stays
     authoritative: when a save or a revalidation returns a different catalog,
     the local copy is stale and is ignored rather than merged. Tracking the two
     together (instead of copying server props into state in an effect) is what
     keeps the panel from showing an order the pipeline does not use. */
  const serverOrder = providers.map((p) => p.id).join("|");
  const [local, setLocal] = useState<{ key: string; ids: string[] }>({
    key: serverOrder,
    ids: providers.map((p) => p.id),
  });
  /* A drag that ends must save what is on screen. Reading the DOM at drag-end
     raced React's render: the last drop's state update had not reached the
     rows yet, so the action saved the PREVIOUS arrangement and still reported
     “Failover order saved”. An orderRef kept beside the state gives the
     drag-end handler the arrangement synchronously — written by every drop,
     read only in handlers, never during render. */
  const orderRef = useRef<string[]>(providers.map((p) => p.id));
  const order = local.key === serverOrder ? local.ids : providers.map((p) => p.id);
  useEffect(() => {
    orderRef.current = order;
  }, [order]);
  const setOrder = (update: (current: string[]) => string[]) => {
    const next = update(orderRef.current);
    orderRef.current = next;
    setLocal({ key: serverOrder, ids: next });
  };
  const [dragging, setDragging] = useState<string | null>(null);
  const [notice, setNotice] = useState<AdminResult>({ ok: false });
  const [testing, startTest] = useTransition();
  const [arranging, startArrange] = useTransition();
  const [savingOrder, startSaveOrder] = useTransition();
  const [adding, setAdding] = useState(false);
  const [presetId, setPresetId] = useState("");
  const [addState, addAction, addPending] = useActionState(saveProviderAction, { ok: false });
  const listRef = useRef<HTMLDivElement | null>(null);
  const pointer = useRef<{ id: string; y: number } | null>(null);

  /* The server is the source of truth: when a save lands, the rows it returns
     replace the local order, so a drag that raced a reload cannot leave the
     panel showing an arrangement the pipeline does not use. */
  const byId = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers]);

  const rows = order.map((id) => byId.get(id)).filter((p): p is ProviderEntry => Boolean(p));

  function drop(targetId: string) {
    if (!dragging || dragging === targetId) return;
    setOrder((current) => {
      const from = current.indexOf(dragging);
      const to = current.indexOf(targetId);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      next.splice(from, 1);
      next.splice(to, 0, dragging);
      return next;
    });
  }

  /* Pointer-based drag rather than the HTML5 drag events: those cannot
     auto-scroll a long list, and a catalog of twelve providers does not fit on
     a laptop screen — dragging to an off-screen row has to work. */
  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: PointerEvent) => {
      pointer.current = { id: dragging, y: event.clientY };

      const list = listRef.current;
      if (list) {
        const rect = list.getBoundingClientRect();
        const margin = 80;
        if (event.clientY < rect.top + margin) {
          window.scrollBy({ top: -18, behavior: "auto" });
        } else if (event.clientY > rect.bottom - margin) {
          window.scrollBy({ top: 18, behavior: "auto" });
        }
      }

      const row = document
        .elementsFromPoint(event.clientX, event.clientY)
        .map((el) => (el instanceof HTMLElement ? el.closest("[data-provider-id]") : null))
        .find(Boolean) as HTMLElement | null;
      const target = row?.dataset.providerId;
      if (target) drop(target);
    };

    const onUp = () => {
      setDragging(null);
      /* From the ref, not the DOM — see the comment on orderRef. A drag that
         ends in the same tick as its last drop still saves what is on screen,
         and a no-op drag does not write at all. */
      const ids = orderRef.current;
      if (ids.length === 0 || ids.join("|") === serverOrder) return;
      startSaveOrder(async () => {
        const result = await reorderProvidersAction(ids);
        setNotice(result);
      });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const addPreset = presets.find((p) => p.id === presetId);

  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-3 py-2.5">
        <p className="mr-auto text-[12.5px] text-t3">
          First row is reached first. Drag to reorder, or let the last test decide.
        </p>
        <form
          action={(formData) => {
            startTest(async () => {
              const result = await testProvidersAction({ ok: false }, formData);
              setNotice(result);
            });
          }}
        >
          <button type="submit" disabled={testing} className={btn("outline", "sm")}>
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {testing ? "Probing…" : "Test all"}
          </button>
        </form>
        <form
          action={() => {
            startArrange(async () => {
              const result = await autoArrangeAction();
              setNotice(result);
            });
          }}
        >
          <button type="submit" disabled={arranging} className={btn("outline", "sm")}>
            {arranging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Auto-arrange
          </button>
        </form>
        <button type="button" onClick={() => setAdding((v) => !v)} className={btn("brand", "sm")}>
          + Add provider
        </button>
      </div>

      {savingOrder ? (
        <p className="border-b border-edge px-4 py-1.5 text-[11.5px] text-t3">Saving the new order…</p>
      ) : null}
      {notice.error || notice.notice ? (
        <div className="border-b border-edge px-4 py-2">
          <Result state={notice} />
        </div>
      ) : null}

      {adding ? (
        <div className="space-y-3 border-b border-edge bg-well/40 px-4 py-4">
          <form action={addAction} className="grid gap-3 md:grid-cols-2">
            <label className="block md:col-span-2">
              <span className="eyebrow eyebrow-strong mb-1.5 block">Start from a known provider (optional)</span>
              <select
                name="presetPick"
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
                className={inputCls}
              >
                <option value="">— custom —</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} ({p.tier})
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="eyebrow eyebrow-strong mb-1.5 block">Name</span>
              <input name="label" key={`l-${presetId}`} defaultValue={addPreset?.label ?? ""} required className={inputCls} />
            </label>
            <label className="block">
              <span className="eyebrow eyebrow-strong mb-1.5 block">Base URL</span>
              <input name="baseUrl" key={`u-${presetId}`} defaultValue={addPreset?.baseUrl ?? ""} placeholder="https://api.example.com/v1" required className={inputCls} />
            </label>
            <label className="block md:col-span-2">
              <span className="eyebrow eyebrow-strong mb-1.5 block">Models — one per line</span>
              <textarea
                name="models"
                key={`m-${presetId}`}
                defaultValue={(addPreset?.models ?? []).join("\n")}
                rows={3}
                placeholder={"gpt-oss-120b\nllama-3.3-70b"}
                required
                className={inputCls + " font-mono text-[12px]"}
              />
            </label>
            <label className="block">
              <span className="eyebrow eyebrow-strong mb-1.5 block">Tier</span>
              <select name="tier" key={`t-${presetId}`} defaultValue={addPreset?.tier ?? "free"} className={inputCls}>
                <option value="free">free</option>
                <option value="premium">premium</option>
              </select>
            </label>
            <label className="block">
              <span className="eyebrow eyebrow-strong mb-1.5 block">API key (encrypted at rest)</span>
              <input name="apiKey" type="password" autoComplete="off" placeholder="paste the key" className={inputCls} />
            </label>
            <label className="block">
              <span className="eyebrow eyebrow-strong mb-1.5 block">…or env var name</span>
              <input name="keyEnv" key={`k-${presetId}`} defaultValue={addPreset?.keyEnv ?? ""} placeholder="MY_PROVIDER_KEY" className={inputCls + " font-mono text-[12px]"} />
            </label>
            <label className="block">
              <span className="eyebrow eyebrow-strong mb-1.5 block">Notes</span>
              <input name="notes" key={`n-${presetId}`} defaultValue={addPreset?.notes ?? ""} className={inputCls} />
            </label>
            <label className="flex items-center gap-2 md:col-span-2">
              <input type="checkbox" name="enabled" defaultChecked className="h-4 w-4" style={{ accentColor: "var(--color-brand, #4f8cff)" }} />
              <span className="text-[12.5px] text-t2">Enabled — join the failover chain now</span>
            </label>
            <div className="md:col-span-2">
              <Result state={addState} />
            </div>
            <div className="flex gap-2 md:col-span-2">
              <button type="submit" disabled={addPending} className={btn("brand", "sm")}>
                {addPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Add to catalog
              </button>
              <button type="button" onClick={() => setAdding(false)} className={btn("ghost", "sm")}>
                <X className="h-3.5 w-3.5" /> Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <div
        ref={listRef}
        onPointerDown={(event) => {
          const handle = (event.target as HTMLElement).closest(".drag-handle");
          const row = (event.target as HTMLElement).closest("[data-provider-id]") as HTMLElement | null;
          if (handle && row?.dataset.providerId) {
            event.preventDefault();
            setDragging(row.dataset.providerId);
          }
        }}
      >
        {rows.map((p) => (
          <div key={p.id} data-provider-id={p.id} className={dragging === p.id ? "opacity-50" : undefined}>
            <ProviderRow provider={p} health={health[p.id]} presets={presets} agents={agents} />
          </div>
        ))}
        {rows.length === 0 ? <p className="px-4 py-3 text-[12.5px] text-t3">No providers yet.</p> : null}
      </div>
    </Panel>
  );
}

/* ————————————————————————— accounts ————————————————————————— */

export type AccountRowData = {
  id: string;
  email: string | null;
  name: string | null;
  plan: string;
  credits: number;
  suspendedAt: string | null;
  runs: number;
  tokens: number;
  createdAt: string;
};

function AccountRow({ account }: { account: AccountRowData }) {
  const [state, action, pending] = useActionState(updateAccountAction, { ok: false });
  const [deleteState, deleteAction, deleting] = useActionState(deleteAccountAction, { ok: false });
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-edge px-4 py-2.5 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-t1">{account.name ?? "—"}</p>
          <p className="truncate font-mono text-[10.5px] text-t3">{account.email}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="hidden font-mono text-[10.5px] text-t3 sm:inline">
            {account.runs} run{account.runs === 1 ? "" : "s"} · {Math.round(account.tokens / 1000)}k tok
          </span>
          <Badge tone={account.plan === "pro" ? "brand" : "neutral"}>{account.plan}</Badge>
          {account.suspendedAt ? <Badge tone="bad">suspended</Badge> : null}
          <span className="tnum font-mono text-[12px] text-t1">
            ${(account.credits / 1000).toFixed(2)}
          </span>
          <button type="button" onClick={() => setOpen((v) => !v)} className={btn("outline", "sm")}>
            <ChevronDown className={"h-3.5 w-3.5 transition-transform " + (open ? "rotate-180" : "")} />
          </button>
        </div>
      </div>

      {state.notice || state.error ? (
        <div className="mt-2">
          <Result state={state} />
        </div>
      ) : null}
      {deleteState.notice || deleteState.error ? (
        <div className="mt-2">
          <Result state={deleteState} />
        </div>
      ) : null}

      {open ? (
        <div className="mt-3 space-y-3 rounded-[10px] border border-edge bg-well/40 p-3">
          <form action={action} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="id" value={account.id} />
            <label className="block min-w-[120px]">
              <span className="eyebrow mb-1 block">Plan</span>
              <select name="plan" defaultValue={account.plan} className={inputCls}>
                <option value="free">free</option>
                <option value="pro">pro</option>
              </select>
            </label>
            <label className="block min-w-[130px]">
              <span className="eyebrow mb-1 block">Balance $ (delta)</span>
              <input
                type="number"
                name="adjustment"
                step="0.01"
                placeholder="5.00"
                className={inputCls}
              />
            </label>
            <label className="block min-w-[130px]">
              <span className="eyebrow mb-1 block">Access</span>
              <select name="suspended" defaultValue={account.suspendedAt ? "true" : "false"} className={inputCls}>
                <option value="false">active</option>
                <option value="true">suspended</option>
              </select>
            </label>
            <button type="submit" disabled={pending} className={btn("brand", "sm")}>
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Apply
            </button>
          </form>

          <form action={deleteAction} className="flex items-center justify-between gap-3 border-t border-edge pt-3">
            <input type="hidden" name="id" value={account.id} />
            <p className="text-[11.5px] text-t3">
              Joined {new Date(account.createdAt).toLocaleDateString()} · {account.runs} run(s),{" "}
              {account.tokens.toLocaleString()} tokens billed
            </p>
            <button type="submit" disabled={deleting} className={btn("outline", "sm")}>
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 text-bad" />}
              Delete account
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

export function AccountList({ accounts }: { accounts: AccountRowData[] }) {
  const [term, setTerm] = useState("");
  const shown = accounts.filter((a) => {
    const t = term.trim().toLowerCase();
    if (!t) return true;
    return (a.email ?? "").toLowerCase().includes(t) || (a.name ?? "").toLowerCase().includes(t);
  });

  return (
    <Panel className="overflow-hidden">
      <div className="border-b border-edge px-3 py-2.5">
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search by email or name…"
          className={inputCls}
        />
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-3 text-[12.5px] text-t3">No account matches.</p>
      ) : (
        shown.map((a) => <AccountRow key={a.id} account={a} />)
      )}
    </Panel>
  );
}

/* ————————————————————————— testing ————————————————————————— */

/** The sweep, on its own page: test everything, then arrange the catalog by
    what the sweep measured. Kept apart from the provider list so an operator
    can look at health without scrolling past twelve edit forms. */
export function TestingControls() {
  const [state, setState] = useState<AdminResult>({ ok: false });
  const [testing, startTest] = useTransition();
  const [arranging, startArrange] = useTransition();

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <p className="text-[13px] font-medium text-t1">Run a sweep</p>
          <p className="mt-1 text-[11.5px] text-t3">
            {testing ? "Probing every enabled provider — this takes a few seconds…" : "One request per model, results saved below."}
          </p>
        </div>
        <form
          action={(formData) => {
            startTest(async () => {
              setState(await testProvidersAction({ ok: false }, formData));
            });
          }}
        >
          <button type="submit" disabled={testing || arranging} className={btn("brand", "md")}>
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {testing ? "Probing…" : "Test all providers"}
          </button>
        </form>
        <form
          action={() => {
            startArrange(async () => {
              setState(await autoArrangeAction());
            });
          }}
        >
          <button type="submit" disabled={testing || arranging} className={btn("outline", "md")}>
            {arranging ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {arranging ? "Arranging…" : "Auto-arrange by speed"}
          </button>
        </form>
      </div>
      {state.error || state.notice ? (
        <div className="mt-3 border-t border-edge pt-3">
          <Result state={state} />
        </div>
      ) : null}
    </Panel>
  );
}

/* ————————————————————————— panel credentials ————————————————————————— */

/** The panel's own username, password and optional access code. Everything here
    is a hash at rest, and saving logs every other device out — which is the
    point of a credential change. */
export function AdminCredentialsForm({
  username,
  requiresCode,
}: {
  username: string;
  requiresCode: boolean;
}) {
  const [state, action, pending] = useActionState(saveAdminCredentialsAction, {});
  return (
    <form action={action} className="space-y-3.5">
      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">Username</span>
        <input name="username" defaultValue={username} required className={inputCls} />
      </label>
      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">New password (blank keeps the current one)</span>
        <input name="password" type="password" autoComplete="new-password" placeholder="••••••••" className={inputCls} />
      </label>
      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">
          Access code {requiresCode ? "— currently required at sign-in" : "— optional"}
        </span>
        <input name="code" placeholder="leave blank for none" className={inputCls} />
        <span className="mt-1 block text-[11px] text-t3">
          An extra code the login asks for after the password. Useful when the panel is on a public address.
        </span>
      </label>
      {requiresCode ? (
        <label className="flex items-center gap-2">
          <input type="checkbox" name="clearCode" className="h-4 w-4" style={{ accentColor: "var(--color-brand, #4f8cff)" }} />
          <span className="text-[12.5px] text-t2">Remove the access code entirely</span>
        </label>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <Result state={state} />
        <button type="submit" disabled={pending} className={btn("brand", "sm", "ml-auto")}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save credentials
        </button>
      </div>
    </form>
  );
}

/* ————————————————————————— policy, infra, runs ————————————————————————— */

export function PolicyForm({ free, pro }: { free: string; pro: string }) {
  const [state, action, pending] = useActionState(setPolicyAction, { ok: false });
  return (
    <form action={action} className="space-y-3.5">
      <p className="text-[13px] font-medium text-t1">Which catalog each plan runs on</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="eyebrow eyebrow-strong mb-1.5 block">Free plan</span>
          <select name="free" defaultValue={free} className={inputCls}>
            <option value="free">free catalog</option>
            <option value="premium">premium catalog</option>
          </select>
        </label>
        <label className="block">
          <span className="eyebrow eyebrow-strong mb-1.5 block">Pro plan</span>
          <select name="pro" defaultValue={pro} className={inputCls}>
            <option value="free">free catalog</option>
            <option value="premium">premium catalog</option>
          </select>
        </label>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Result state={state} />
        <button type="submit" disabled={pending} className={btn("brand", "sm", "ml-auto")}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save policy
        </button>
      </div>
    </form>
  );
}

export function InfraForm({
  hasGithub,
  hasVercel,
  teamId,
}: {
  hasGithub: boolean;
  hasVercel: boolean;
  teamId: string | null;
}) {
  const [state, action, pending] = useActionState(setInfraAction, { ok: false });
  return (
    <form action={action} className="space-y-3.5">
      <p className="text-[13px] font-medium text-t1">Tokens and hosting</p>
      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">
          GitHub token {hasGithub ? "— stored, paste to replace" : ""}
        </span>
        <input name="githubToken" type="password" autoComplete="off" placeholder={hasGithub ? "••••••" : "ghp_…"} className={inputCls} />
      </label>
      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">
          Vercel token {hasVercel ? "— stored, paste to replace" : ""}
        </span>
        <input name="vercelToken" type="password" autoComplete="off" placeholder={hasVercel ? "••••••" : "vercel_…"} className={inputCls} />
      </label>
      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">Vercel team / scope id</span>
        <input name="vercelTeamId" defaultValue={teamId ?? ""} placeholder="team_…" className={inputCls} />
      </label>
      <div className="flex items-center justify-between gap-3">
        <Result state={state} />
        <button type="submit" disabled={pending} className={btn("brand", "sm", "ml-auto")}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save infrastructure
        </button>
      </div>
    </form>
  );
}

export function StopRunButton({ runId, label }: { runId: string; label: string }) {
  const [state, action, pending] = useActionState(adminStopRunAction, { ok: false });
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="id" value={runId} />
      <button type="submit" disabled={pending} className={btn("outline", "sm")}>
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {label}
      </button>
      {state.error ? <span className="text-[11px] text-bad">{state.error}</span> : null}
    </form>
  );
}
