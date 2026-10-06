import { Wordmark } from "@/components/nav";

const LINKS = [
  { href: "#why", label: "Why" },
  { href: "#pipeline", label: "Pipeline" },
  { href: "#proof", label: "Proof" },
  { href: "#compare", label: "Compare" },
  { href: "#faq", label: "FAQ" },
  { href: "#waitlist", label: "Waitlist" },
];

export function Footer() {
  return (
    <footer className="border-t border-line bg-deep/60">
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          <div className="max-w-sm">
            <Wordmark />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-dim">
              The last mile, closed. Research → spec → your approval → build → deploy & verify —
              a working link, already checked.
            </p>
          </div>

          <nav className="grid grid-cols-2 gap-x-14 gap-y-3 sm:grid-cols-3">
            {LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="font-mono text-[11px] uppercase tracking-[0.18em] text-dim transition-colors hover:text-iris"
              >
                {l.label}
              </a>
            ))}
          </nav>
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-line pt-6 font-mono text-[10.5px] uppercase tracking-[0.14em] text-dim/60 md:flex-row md:items-center md:justify-between">
          <p>© 2026 lastmile — a “zero to idea” build by Amitesh Yadav · Samsara World Academy</p>
          <p className="flex items-center gap-2">
            <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-iris/80" />
            this page’s meta tags were verified ✓
          </p>
        </div>
      </div>
    </footer>
  );
}
