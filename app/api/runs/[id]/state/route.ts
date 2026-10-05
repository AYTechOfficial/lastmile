import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRunState } from "@/lib/run-engine";
import { serializeRunState } from "@/lib/run-dto";

/* Polling endpoint for the live run view. Reading a run also advances it —
   advanceRun() is the single place that reconciles what the agents did with
   what the row says, and it recovers runs whose job died with the process. */

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const state = await getRunState(id, session.user.id);
  if (!state) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json(serializeRunState(state), {
    headers: { "cache-control": "no-store" },
  });
}
