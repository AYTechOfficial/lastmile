import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { auth, isAdminEmail } from "@/lib/auth";
import { db } from "@/lib/db";
import { runs } from "@/lib/schema";
import { providerStates } from "@/lib/ai/providers";
import { searchProviderStates } from "@/lib/ai/search";
import { Shell, type ProviderLine } from "@/components/app/shell";

/* App shell for every authenticated page: no session → straight to /login. */

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const name = session.user.name ?? session.user.email?.split("@")[0] ?? "builder";
  const email = session.user.email ?? "";

  const recent = await db
    .select({
      id: runs.id,
      runNumber: runs.runNumber,
      title: runs.title,
      status: runs.status,
    })
    .from(runs)
    .where(eq(runs.userId, userId))
    .orderBy(desc(runs.createdAt))
    .limit(8);

  // "live" and "waiting on you" are genuinely different states — a run that is
  // blocked on a human is not working, and the rail should say so.
  const activeCount = recent.filter((r) => !["done", "failed", "awaiting_approval"].includes(r.status)).length;
  const awaitingCount = recent.filter((r) => r.status === "awaiting_approval").length;

  /* One catalog, read from the database. The old build kept a separate
     env-scanned list *and* an admin catalog, which would list every provider
     twice now that the catalog is the source of truth. Search is resolved per
     user, because a user's own key outranks the platform's. */
  const llm: ProviderLine[] = (await providerStates()).map((p) => ({
    id: p.def.id,
    label: p.def.label,
    configured: p.configured,
    freeTier: p.def.freeTier,
  }));
  const search: ProviderLine[] = (await searchProviderStates(userId)).map((p) => ({
    id: p.id,
    label: p.label,
    configured: p.configured,
    freeTier: p.freeTier,
  }));

  return (
    <Shell
      name={name}
      email={email}
      runs={recent}
      activeCount={activeCount}
      awaitingCount={awaitingCount}
      isAdmin={await isAdminEmail(email)}
      providers={{ llm, search }}
    >
      {children}
    </Shell>
  );
}
