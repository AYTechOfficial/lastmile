import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runs } from "@/lib/schema";
import { and, eq } from "drizzle-orm";
import { zipWorkspace } from "@/lib/platform/workspace";

/* Codebase download: zips the run's workspace on demand so the artifact is
   always current, then streams it. */

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return new Response("unauthorized", { status: 401 });

  const { id } = await params;
  const [run] = await db
    .select({ id: runs.id, title: runs.title })
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.userId, session.user.id)))
    .limit(1);
  if (!run) return new Response("not found", { status: 404 });

  let path: string;
  try {
    path = zipWorkspace(id);
  } catch {
    return new Response("nothing to download yet — the coding agent has not produced files", { status: 409 });
  }
  if (!existsSync(path)) return new Response("nothing to download yet", { status: 409 });

  const size = statSync(path).size;
  const slug = run.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "codebase";
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;

  return new Response(stream, {
    headers: {
      "content-type": "application/zip",
      "content-length": String(size),
      "content-disposition": `attachment; filename="${slug}.zip"`,
      "cache-control": "no-store",
    },
  });
}
