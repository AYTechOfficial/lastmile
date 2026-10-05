import { auth } from "@/lib/auth";
import { getRunState } from "@/lib/run-engine";
import { serializeRunState } from "@/lib/run-dto";

/* Server-sent events: the live terminal and the orchestration canvas
   subscribe here. Every message is a full serialized run state — simple,
   consistent, and each frame is genuinely what the database holds. The client
   falls back to polling automatically if the stream fails to open. */

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("unauthorized", { status: 401 });
  }
  const { id } = await params;

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      };

      let lastSignature = "";

      const tick = async () => {
        if (closed) return;
        try {
          const state = await getRunState(id, session.user!.id!);
          if (!state) {
            send("event: end\ndata: notfound\n\n");
            closed = true;
            controller.close();
            return;
          }
          const serialized = JSON.stringify(serializeRunState(state));
          // only ship frames that actually changed
          const signature = serialized.length + ":" + state.run.status + ":" + state.events.length;
          if (signature !== lastSignature) {
            lastSignature = signature;
            send("data: " + serialized + "\n\n");
          }
          if (state.run.status === "done" || state.run.status === "failed") {
            send("event: end\ndata: " + state.run.status + "\n\n");
            closed = true;
            controller.close();
          }
        } catch {
          /* transient db error — next tick retries */
        }
      };

      await tick();
      const interval = setInterval(() => {
        if (closed) {
          clearInterval(interval);
          return;
        }
        void tick();
      }, 1200);
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
    },
  });
}
