import Link from "next/link";
import { Check, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { STAGE_META, STAGE_ORDER } from "@/components/app/status";

/* Auth screens get the same instrument language as the app, plus one panel
   that shows what the account is actually for. A sign-in page is a product
   surface like any other. */
export function AuthShell({
  title,
  children,
  footer,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="relative min-h-screen bg-app text-t1">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="rule-grid absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_60%_50%_at_30%_0%,black,transparent_70%)]" />
        <div className="absolute -left-40 top-[-160px] h-[420px] w-[720px] rounded-full bg-brand/[0.07] blur-[140px]" />
      </div>

      <div className="relative mx-auto grid min-h-screen max-w-[1180px] lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
        {/* ————— form ————— */}
        <div className="flex flex-col justify-center px-6 py-14 md:px-14">
          <div className="mx-auto w-full max-w-[400px]">
            <Link href="/" className="group flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-brand/40 bg-brand/12 transition-colors group-hover:bg-brand/20">
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path
                    d="M4 13.5 9.5 19 20 6.5"
                    stroke="#7c7aff"
                    strokeWidth="2.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span className="display text-[16px] font-semibold tracking-tight text-t1">
                lastmile<span className="text-brand">.</span>
              </span>
            </Link>

            <h1 className="display mt-9 text-[27px] font-semibold leading-[1.15] tracking-[-0.03em] text-t1">
              {title}
            </h1>

            <div className="mt-7">{children}</div>

            {footer ? <div className="mt-6 text-[13px] text-t3">{footer}</div> : null}
          </div>
        </div>

        {/* ————— proof ————— */}
        <aside className="relative hidden border-l border-edge bg-well/60 p-10 lg:flex lg:flex-col lg:justify-center">
          <div className="relative">
            <p className="eyebrow">What happens after you sign up</p>

            <ol className="mt-6 space-y-1">
              {STAGE_ORDER.map((stage, i) => {
                const amber = stage === "checkpoint";
                const green = stage === "verify";
                return (
                  <li key={stage} className="relative flex gap-3.5 pb-4 last:pb-0">
                    {i < STAGE_ORDER.length - 1 ? (
                      <span aria-hidden className="absolute left-[13px] top-7 h-full w-px bg-edge" />
                    ) : null}
                    <span
                      className={
                        "relative z-10 mt-0.5 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border font-mono text-[9.5px] " +
                        (amber
                          ? "border-warn/50 bg-warn/12 text-warn"
                          : green
                            ? "border-pass/40 bg-pass/12 text-pass"
                            : "border-edge bg-surface2 text-t3")
                      }
                    >
                      {i + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-t1">{STAGE_META[stage].label}</p>
                      <p className="mt-0.5 text-[11.5px] leading-snug text-t3">{STAGE_META[stage].hint}</p>
                    </div>
                  </li>
                );
              })}
            </ol>

            <div className="mt-7 rounded-[14px] border border-pass/25 bg-pass/[0.05] p-4">
              <p className="flex items-center gap-2 text-[12.5px] font-medium text-t1">
                <ShieldCheck className="h-3.5 w-3.5 text-pass" />
                You only ever receive a link that passed
              </p>
              <ul className="mt-2.5 space-y-1.5">
                {["real browser, real clicks", "screenshots, logs and a trace attached", "fails are fixed and re-tested"].map(
                  (t) => (
                    <li key={t} className="flex gap-2 text-[11.5px] text-t3">
                      <Check className="mt-[3px] h-3 w-3 shrink-0 text-pass/70" strokeWidth={2.5} />
                      {t}
                    </li>
                  ),
                )}
              </ul>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
