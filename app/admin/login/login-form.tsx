"use client";

import { useActionState } from "react";
import { Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { btn } from "@/components/kit";
import { adminLoginAction, type AdminLoginState } from "@/app/actions/admin-auth";

const inputCls =
  "w-full rounded-[10px] border border-edge bg-well px-3.5 py-2.5 text-[13.5px] text-t1 outline-none transition-colors placeholder:text-t3 focus:border-brand/60";

export function AdminLoginForm({ requiresCode }: { requiresCode: boolean }) {
  const [state, action, pending] = useActionState<AdminLoginState, FormData>(adminLoginAction, {});

  return (
    <form action={action} className="space-y-4">
      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">Username</span>
        <input name="username" autoComplete="username" required autoFocus placeholder="admin" className={inputCls} />
      </label>
      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="••••••••"
          className={inputCls}
        />
      </label>
      {requiresCode ? (
        <label className="block">
          <span className="eyebrow eyebrow-strong mb-1.5 block">Access code</span>
          <input name="code" inputMode="numeric" required placeholder="••••••" className={inputCls} />
          <span className="mt-1 block text-[11px] text-t3">
            This panel requires the extra code an operator set in Settings.
          </span>
        </label>
      ) : null}

      {state.error ? (
        <p role="alert" className="flex items-start gap-2 text-[12px] text-bad">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {state.error}
        </p>
      ) : null}

      <button type="submit" disabled={pending} className={btn("brand", "md", "w-full justify-center")}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
        {pending ? "Checking…" : "Open the panel"}
      </button>
    </form>
  );
}
