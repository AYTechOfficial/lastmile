import Link from "next/link";
import { Compass } from "lucide-react";
import { btn } from "@/components/kit";

export const metadata = { title: "Not found — LastMile" };

export default function NotFound() {
  return (
    <main className="relative flex min-h-screen items-center justify-center bg-app px-6 text-t1">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="rule-grid absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_50%_40%_at_50%_0%,black,transparent_70%)]" />
      </div>
      <div className="relative text-center">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-[13px] border border-edge bg-surface2 text-t3">
          <Compass className="h-5 w-5" />
        </span>
        <p className="eyebrow mt-5">404</p>
        <h1 className="display mt-2 text-[24px] font-semibold tracking-[-0.03em]">
          That page was never built
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-t3">
          The link is wrong, or the run it pointed at was deleted.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Link href="/dashboard" className={btn("primary", "md")}>
            Back to dashboard
          </Link>
          <Link href="/" className={btn("outline", "md")}>
            Marketing site
          </Link>
        </div>
      </div>
    </main>
  );
}
