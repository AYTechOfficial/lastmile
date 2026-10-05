import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runs } from "@/lib/schema";
import { and, eq } from "drizzle-orm";
import { listFiles, readWorkspaceFile } from "@/lib/platform/workspace";
import { githubTokenForUser, parseRepoUrl, restoreWorkspaceFromGithub } from "@/lib/platform/github";
import { resolveInfraToken } from "@/lib/platform/settings";

/* Code viewer API: the generated codebase's file tree and file contents.
   Scoped to the owner; paths are validated inside the workspace module. */

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const [run] = await db
    .select({ id: runs.id, repoUrl: runs.repoUrl })
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.userId, session.user.id)))
    .limit(1);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });

  const url = new URL(req.url);
  const file = url.searchParams.get("file");

  /* A shipped run's workspace was released after deploy — the repo on GitHub
     is the source of truth now. Refill the workspace transparently so the
     code viewer keeps working on old runs instead of showing an empty tree. */
  if (listFiles(id).length === 0 && run.repoUrl) {
    const parsed = parseRepoUrl(run.repoUrl);
    const token = parsed ? (await githubTokenForUser(session.user.id)) ?? (await resolveInfraToken("github")) : null;
    if (parsed && token) {
      try {
        await restoreWorkspaceFromGithub(token, parsed, id);
      } catch {
        /* the viewer below will report the empty tree */
      }
    }
  }

  if (file) {
    const content = readWorkspaceFile(id, file);
    if (content === null) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ file, content: content.slice(0, 60_000) }, { headers: { "cache-control": "no-store" } });
  }

  return NextResponse.json(
    { files: listFiles(id) },
    { headers: { "cache-control": "no-store" } },
  );
}
