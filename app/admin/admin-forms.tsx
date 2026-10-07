"use client";

import { useActionState } from "react";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import { btn } from "@/components/kit";
import { grantCreditsAction, setCreditPricingAction, type AdminResult } from "@/app/actions/admin";

const inputCls =
  "w-full rounded-[10px] border border-edge bg-well px-3.5 py-2.5 text-[13.5px] text-t1 outline-none transition-colors placeholder:text-t3 focus:border-brand/60";

function Result({ state }: { state: AdminResult }) {
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
      <p className="text-[13px] font-medium text-t1">Adjust a balance</p>
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
