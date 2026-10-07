import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runs } from "@/lib/schema";
import { getRepoFile, listRepoFiles } from "@/lib/platform/github";

/* The run page's Code tab: the workspace of the run, read straight from the
   repo. The repo IS the build workspace, so this endpoint is a thin view over
   it — a flat file list for the tree, and one file's text when a path is
   named. A run with no repo yet answers an empty list, which the tab renders
   as "files appear the moment the Coding Agent lands them". */

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const [run] = await db
    .select({ repoOwner: runs.repoOwner, repoName: runs.repoName })
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.userId, session.user.id)))
    .limit(1);

  if (!run) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!run.repoOwner || !run.repoName) {
    return NextResponse.json({ files: [] }, { headers: { "cache-control": "no-store" } });
  }

  const wanted = new URL(req.url).searchParams.get("file");
  if (wanted) {
    /* Only paths that actually exist in this repo are readable — a tampered
       query cannot be used to pull arbitrary files. */
    const files = await listRepoFiles(run.repoOwner, run.repoName);
    if (!files?.includes(wanted)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const content = await getRepoFile(run.repoOwner, run.repoName, wanted);
    return NextResponse.json(
      { content },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const files = await listRepoFiles(run.repoOwner, run.repoName);
  return NextResponse.json(
    { files: files ?? [] },
    { headers: { "cache-control": "no-store" } },
  );
}
