"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Activity,
  ArrowLeft,
  FlaskConical,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Server,
  Users,
  X,
} from "lucide-react";
import { adminLogoutAction } from "@/app/actions/admin-auth";

const LINKS = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/providers", label: "Providers", icon: Server },
  { href: "/admin/testing", label: "Testing", icon: FlaskConical },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/runs", label: "Runs", icon: Activity },
  { href: "/admin/settings", label: "Settings", icon: KeyRound },
];

/** The panel's own navigation. A sidebar on a desktop, a drawer on a phone —
    one control surface either way, and never the product's own nav. */
export function AdminNav({ label, via }: { label: string; via: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [leaving, startLeave] = useTransition();

  const nav = (
    <nav className="flex flex-col gap-1">
      {LINKS.map((link) => {
        const active = link.href === "/admin" ? pathname === "/admin" : pathname.startsWith(link.href);
        const Icon = link.icon;
        return (
          <Link
            key={link.href}
            href={link.href}
            onClick={() => setOpen(false)}
            className={
              "flex items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] transition-colors " +
              (active
                ? "bg-brand/12 text-brand"
                : "text-t2 hover:bg-white/[0.03] hover:text-t1")
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {link.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <>
      {/* Phone: a bar with the drawer control. Desktop: nothing here — the
          sidebar below is always visible. */}
      <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-edge bg-ink/95 px-4 py-3 backdrop-blur lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-edge p-1.5 text-t2"
          aria-label="Open admin navigation"
        >
          <Menu className="h-4 w-4" />
        </button>
        <p className="display text-[14px] font-semibold text-t1">LastMile Admin</p>
      </div>

      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-[263px] border-r border-edge bg-ink p-4">
            <div className="mb-4 flex items-center justify-between">
              <p className="display text-[14px] font-semibold text-t1">Admin</p>
              <button type="button" onClick={() => setOpen(false)} className="text-t3" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
            {nav}
            <Footer label={label} via={via} onLogout={() => startLeave(() => void adminLogoutAction())} leaving={leaving} />
          </aside>
        </div>
      ) : null}

      <aside className="sticky top-0 hidden h-screen w-[263px] shrink-0 flex-col border-r border-edge bg-ink px-4 py-5 lg:flex">
        <div className="mb-6">
          <p className="eyebrow">Operator panel</p>
          <p className="display mt-1 text-[16px] font-semibold tracking-[-0.02em] text-t1">LastMile Admin</p>
        </div>
        {nav}
        <Footer label={label} via={via} onLogout={() => startLeave(() => void adminLogoutAction())} leaving={leaving} />
      </aside>
    </>
  );
}

function Footer({
  label,
  via,
  onLogout,
  leaving,
}: {
  label: string;
  via: string;
  onLogout: () => void;
  leaving: boolean;
}) {
  return (
    <div className="mt-auto space-y-2 border-t border-edge pt-4">
      <div className="px-1">
        <p className="truncate text-[12px] font-medium text-t1">{label}</p>
        <p className="text-[10.5px] uppercase tracking-[0.12em] text-t3">
          {via === "panel" ? "panel session" : "operator account"}
        </p>
      </div>
      <button
        type="button"
        onClick={onLogout}
        disabled={leaving}
        className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[13px] text-t2 transition-colors hover:bg-white/[0.03] hover:text-t1"
      >
        <LogOut className="h-4 w-4" />
        {leaving ? "Signing out…" : "Sign out"}
      </button>
      <Link
        href="/dashboard"
        className="flex items-center gap-2 rounded-[10px] px-3 py-2 text-[12.5px] text-t3 transition-colors hover:text-t2"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to the product
      </Link>
    </div>
  );
}
