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
  /* TEMP DEBUG — production hides server errors behind a minified digest;
     render the real one until the run-page 500 is root-caused. */
  let state;
  try {
    state = await getRunState(id, session.user.id);
  } catch (e) {
    return (
      <pre
        style={{ maxWidth: 900, margin: "40px auto", padding: 16, overflowX: "auto", fontSize: 12, whiteSpace: "pre-wrap" }}
      >
        {"RUN PAGE DEBUG\n" + (e instanceof Error ? (e.stack ?? e.message) : String(e))}
      </pre>
    );
  }
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
