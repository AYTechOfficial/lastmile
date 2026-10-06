import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getRunState } from "@/lib/run-engine";
import { serializeRunState } from "@/lib/run-dto";
import { RunView } from "@/components/app/run-view";

export const metadata = { title: "Run — LastMile" };

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const { id } = await params;

  const state = await getRunState(id, session.user.id);
  if (!state) notFound();

  /* Keyed on the server snapshot: when an action revalidates this route
     (approve, request changes) the live view remounts with the new state
     instead of keeping stale client state. */
  const snapshotKey = [
    state.run.status,
    state.run.specVariant,
    state.run.iterations,
    state.events.length,
    state.flows.length,
    state.agents.length,
  ].join(":");

  return <RunView key={snapshotKey} initial={serializeRunState(state)} />;
}
