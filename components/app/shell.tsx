"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AlertTriangle,
  ChevronsLeft,
  ChevronsRight,
  Cpu,
  Globe,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Kbd, btn } from "@/components/kit";
import { CommandPalette, type PaletteRun } from "./command-palette";
import { directSignOut } from "@/lib/client-auth";

export type ProviderLine = { id: string; label: string; configured: boolean; freeTier: string };

const pad = (n: number) => "#" + String(n).padStart(4, "0");

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

/* Admin is rendered separately and only when the server says this email is an
   admin — the link must not exist in the DOM for anyone else. */
const ADMIN_NAV = { href: "/admin", label: "Admin", icon: ShieldCheck };

/* The app shell: a fixed rail, a sticky context bar, and a command palette.
   The rail is information, not decoration — it carries what is running right
   now, which is the only thing worth putting in permanent chrome. */
export function Shell({
  name,
  email,
  image,
  creditsMilli,
  runs,
  activeCount,
  awaitingCount,
  providers,
  isAdmin,
  children,
}: {
  name: string;
  email: string;
  image?: string | null;
  /** spendable balance in milli-USD — shown in the topbar */
  creditsMilli: number;
  runs: PaletteRun[];
  activeCount: number;
  awaitingCount: number;
  providers: { llm: ProviderLine[]; search: ProviderLine[] };
  isAdmin: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  /* Compressed rail: icon-only navigation. Stored per device and restored
     after mount, so the server render and the first client render agree. */
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("lastmile.rail");
    } catch {
      /* private browsing — default to expanded */
    }
    if (saved !== "collapsed") return;
    /* restore on the next frame: the first paint stays stable and the effect
       never calls setState synchronously */
    const id = requestAnimationFrame(() => setCollapsed(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const toggleRail = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem("lastmile.rail", c ? "open" : "collapsed");
      } catch {
        /* non-persistent is fine */
      }
      return !c;
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const closeNav = () => setNavOpen(false);

  const crumb = useMemo(() => {
    if (pathname === "/dashboard") return "Overview";
    if (pathname.startsWith("/dashboard/settings")) return "Settings";
    if (pathname.startsWith("/admin")) return "Admin";
    const match = runs.find((r) => pathname.includes(r.id));
    return match ? pad(match.runNumber) + " · " + match.title : "Run";
  }, [pathname, runs]);

  const liveLlm = providers.llm.filter((p) => p.configured);
  const liveSearch = providers.search.find((p) => p.configured);

  const rail = (railCollapsed: boolean) => (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <Link
          href="/dashboard"
          onClick={closeNav}
          title="Overview"
          className="group flex items-center gap-2.5"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-[9px] border border-brand/40 bg-brand/12 transition-colors group-hover:bg-brand/20">
            <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
              <path
                d="M4 13.5 9.5 19 20 6.5"
                stroke="#7c7aff"
                strokeWidth="2.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          {!railCollapsed && (
            <span className="display text-[15px] font-semibold tracking-tight text-t1">
              lastmile<span className="text-brand">.</span>
            </span>
          )}
        </Link>
        <div className="flex items-center">
          {/* the compress toggle — desktop only; the mobile drawer keeps its close X */}
          <button
            type="button"
            onClick={toggleRail}
            title={railCollapsed ? "Expand sidebar" : "Compress sidebar"}
            aria-label={railCollapsed ? "Expand sidebar" : "Compress sidebar"}
            className="hidden h-7 w-7 items-center justify-center rounded-[8px] text-t3 transition-colors hover:bg-surface2 hover:text-t1 md:flex"
          >
            {railCollapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => setNavOpen(false)}
            className="text-t3 hover:text-t1 md:hidden"
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="px-3">
        <Link href="/dashboard#compose" onClick={closeNav} title="New run" className={btn("brand", "md", "w-full")}>
          <Plus className="h-4 w-4" />
          {!railCollapsed && "New run"}
        </Link>
      </div>

      <nav className="mt-5 space-y-0.5 px-3">
        {[...NAV, ...(isAdmin ? [ADMIN_NAV] : [])].map((item) => {
          const active = item.href === "/dashboard" ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={closeNav}
              title={item.label}
              className={cn(
                "relative flex items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] transition-colors",
                railCollapsed && "justify-center px-0",
                active
                  ? "bg-[linear-gradient(90deg,rgba(124,122,255,0.16),rgba(124,122,255,0.03))] font-medium text-t1 [box-shadow:inset_2px_0_0_var(--app-brand)]"
                  : "text-t2 hover:bg-surface2/60 hover:text-t1",
              )}
            >
              <item.icon className={cn("h-4 w-4", active ? "text-brand" : "text-t3")} />
              {!railCollapsed && item.label}
              {active && !railCollapsed ? <span className="live-dot ml-auto h-1 w-1 text-brand" /> : null}
            </Link>
          );
        })}
      </nav>

      {/* collapsed: the runs list lives in the full rail only — keep the footer pinned */}
      {railCollapsed && <div className="min-h-0 flex-1" />}

      <div className={cn("mt-6 flex min-h-0 flex-1 flex-col px-3", railCollapsed && "md:hidden")}>
        <div className="flex min-h-[18px] items-center justify-between gap-2 px-1.5 pb-2">
          <span className="eyebrow">Runs</span>
          <span className="flex items-center gap-2.5">
            {awaitingCount > 0 ? (
              <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-warn">
                {awaitingCount} waiting on you
              </span>
            ) : null}
            {activeCount > 0 ? (
              <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-brand">
                <span className="live-dot h-1.5 w-1.5" />
                {activeCount} live
              </span>
            ) : null}
          </span>
        </div>

        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto pb-2">
          {runs.length === 0 ? (
            <p className="px-1.5 py-2 text-[12px] leading-relaxed text-t3">
              Runs appear here the moment you start one.
            </p>
          ) : (
            runs.map((r) => {
              const active = pathname.includes(r.id);
              return (
                <Link
                  key={r.id}
                  href={"/dashboard/runs/" + r.id}
                  onClick={closeNav}
                  className={cn(
                    "block rounded-[10px] px-2.5 py-2 transition-colors",
                    active ? "bg-surface2" : "hover:bg-surface2/60",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="tnum shrink-0 font-mono text-[9.5px] text-t3">{pad(r.runNumber)}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-t2">{r.title}</span>
                  </div>
                  <p
                    className={cn(
                      "mt-1 pl-[38px] font-mono text-[9px] uppercase tracking-[0.12em]",
                      r.status === "awaiting_approval"
                        ? "text-warn"
                        : r.status === "done"
                          ? "text-pass"
                          : r.status === "failed"
                            ? "text-bad"
                            : ["queued", "researching", "spec", "building", "deploying", "verifying", "prompting", "coding", "reviewing", "testing"].includes(r.status)
                              ? "text-brand"
                              : r.status === "fixing"
                                ? "text-warn"
                                : "text-t3",
                    )}
                  >
                    {r.status.replace(/_/g, " ")}
                  </p>
                </Link>
              );
            })
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-edge p-3">
        <div className={cn("flex items-center gap-2.5 px-1.5 py-1.5", railCollapsed && "justify-center px-0")}>
          {/* the whole identity block opens Settings — the account lives there */}
          <Link
            href="/dashboard/settings#profile"
            title={name + " · " + email + " — open settings"}
            className={cn(
              "group flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] p-1 transition-colors hover:bg-surface2/70",
              railCollapsed && "flex-none",
            )}
          >
            <span className="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-edge bg-gradient-to-br from-brand/50 to-info/30 text-[11px] font-semibold text-white">
              {image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={image} alt="" className="h-full w-full object-cover" />
              ) : (
                name.slice(0, 1).toUpperCase()
              )}
              <span className="absolute inset-0 hidden items-center justify-center bg-black/55 text-t3 group-hover:flex" aria-hidden>
                <Settings className="h-3.5 w-3.5" />
              </span>
            </span>
            {!railCollapsed && (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-t1">{name}</span>
                <span className="block truncate font-mono text-[9.5px] text-t3">{email}</span>
              </span>
            )}
          </Link>
          {!railCollapsed && (
            <button
              type="button"
              onClick={() => void directSignOut()}
              title="Sign out"
              aria-label="Sign out"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-t3 transition-colors hover:bg-surface2 hover:text-bad"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-app text-t1">
      {/* ambient structure — a fine grid, a cold aurora bloom, and a floor glow */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <div className="rule-grid absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_70%_50%_at_50%_0%,black,transparent_75%)]" />
        <div className="absolute -top-52 left-1/2 h-[480px] w-[980px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(124,122,255,0.09),rgba(76,201,240,0.04)_55%,transparent_75%)] blur-[110px]" />
        <div className="absolute bottom-0 left-0 right-0 h-[320px] bg-[radial-gradient(60%_100%_at_50%_100%,rgba(124,122,255,0.05),transparent_70%)]" />
      </div>

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 hidden border-r border-edge bg-[linear-gradient(180deg,rgba(14,16,24,0.88),rgba(6,7,12,0.92))] backdrop-blur-xl transition-[width] duration-200 ease-out md:block",
          "[box-shadow:1px_0_0_0_rgba(255,255,255,0.04)_inset,24px_0_60px_-40px_rgba(0,0,0,0.9)]",
          collapsed ? "w-[64px]" : "w-[248px]",
        )}
      >
        {rail(collapsed)}
      </aside>

      {navOpen ? (
        <>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
          />
          <aside className="fixed inset-y-0 left-0 z-50 w-[268px] border-r border-edge bg-well md:hidden">
            {rail(false)}
          </aside>
        </>
      ) : null}

      <div
        className={cn(
          "relative z-10 transition-[padding] duration-200 ease-out",
          collapsed ? "md:pl-[64px]" : "md:pl-[248px]",
        )}
      >
        <header className="sticky top-0 z-30 border-b border-edge bg-[linear-gradient(180deg,rgba(10,11,16,0.92),rgba(10,11,16,0.78))] backdrop-blur-xl [box-shadow:0_1px_0_0_rgba(255,255,255,0.03)_inset]">
          <div className="flex h-14 items-center gap-3 px-4 md:px-6">
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-[9px] border border-edge text-t2 md:hidden"
              aria-label="Open navigation"
            >
              <Menu className="h-4 w-4" />
            </button>

            <div className="flex min-w-0 items-center gap-2">
              <span className="eyebrow hidden sm:inline">Workspace</span>
              <span className="hidden text-t3 sm:inline">/</span>
              <span className="min-w-0 truncate text-[13.5px] font-medium text-t1">{crumb}</span>
            </div>

            <div className="ml-auto flex items-center gap-2">
              {/* the spendable balance — one glance answers "can I run another build?" */}
              <Link
                href="/dashboard/settings#credits"
                title="Credit balance — runs are charged per token"
                className={cn(
                  "flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] border px-2.5 text-[11.5px] transition-colors",
                  creditsMilli <= 0
                    ? "border-bad/40 bg-bad/10 text-bad"
                    : creditsMilli < 2000
                      ? "border-warn/40 bg-warn/10 text-warn"
                      : "border-edge bg-surface text-t2 hover:border-edge2",
                )}
              >
                <Wallet className="h-3.5 w-3.5" />
                <span className="tnum font-mono">${(creditsMilli / 1000).toFixed(2)}</span>
              </Link>
              <EngineChips llm={liveLlm} search={liveSearch} />
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="flex h-8 items-center gap-2 rounded-[9px] border border-edge bg-surface/80 px-2.5 text-[12px] text-t3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition-colors hover:border-edge2 hover:text-t2"
              >
                <Search className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Search</span>
                <span className="hidden items-center gap-0.5 sm:flex">
                  <Kbd>⌘</Kbd>
                  <Kbd>K</Kbd>
                </span>
              </button>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1180px] px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} runs={runs} />
    </div>
  );
}

/* What the pipeline is actually running on. If nothing is configured this is
   the most useful thing on the screen, so it says so instead of hiding. */
function EngineChips({ llm, search }: { llm: ProviderLine[]; search?: ProviderLine }) {
  if (llm.length === 0) {
    return (
      <Link
        href="/dashboard/settings"
        className="flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-[9px] border border-warn/30 bg-warn/10 px-2.5 text-[12px] text-warn transition-colors hover:bg-warn/15"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">No model key — running degraded</span>
        <span className="sm:hidden">Degraded</span>
      </Link>
    );
  }

  return (
    <div className="hidden items-center gap-1.5 lg:flex">
      <span className="flex h-8 items-center gap-2 rounded-[9px] border border-edge bg-surface px-2.5 text-[11.5px] text-t2">
        <Cpu className="h-3.5 w-3.5 text-brand" />
        <span className="font-mono text-[10.5px] tracking-wide">{llm.map((p) => p.label).join(" · ")}</span>
      </span>
      {search ? (
        <span className="flex h-8 items-center gap-2 rounded-[9px] border border-edge bg-surface px-2.5 text-[11.5px] text-t2">
          <Globe className="h-3.5 w-3.5 text-info" />
          <span className="font-mono text-[10.5px] tracking-wide">{search.label}</span>
        </span>
      ) : null}
    </div>
  );
}
