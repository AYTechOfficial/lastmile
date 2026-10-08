import { redirect } from "next/navigation";
import { panelAccess } from "@/lib/platform/admin-auth";
import { AdminNav } from "../admin-nav";

export const metadata = { title: "Admin — LastMile" };

/* Everything under this layout is the operator panel, and every page in it is
   behind the same door: a panel session, or a signed-in account whose address is
   on the operator list. Checked here rather than per page, so a new page cannot
   forget it — the login page lives outside this group on purpose. */

export default async function AdminPanelLayout({ children }: { children: React.ReactNode }) {
  const access = await panelAccess();
  if (!access.ok) redirect("/admin/login");

  return (
    <div className="flex min-h-screen flex-col bg-ink lg:flex-row">
      <AdminNav label={access.label} via={access.as} />
      <main className="min-w-0 flex-1 px-5 py-6 sm:px-8 sm:py-8">
        <div className="mx-auto w-full max-w-[1120px] space-y-8">{children}</div>
      </main>
    </div>
  );
}
