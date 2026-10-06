import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { runIssues } from "../schema";
import type { Severity } from "../domain";

/* The defect ledger.

   The verifier (code vs. master prompt) and the live QA pass (deployed URL)
   both write here. The fix loop reads the open rows, re-patches *only* the
   files they name, and marks them fixed. Keeping the ledger in the database
   rather than in memory is what lets a different runner pick up the fix round —
   the previous build's loop lived and died with one process. */

export type RunIssue = {
  id: string;
  iteration: number;
  source: "verify" | "test";
  severity: Severity;
  title: string;
  detail: string | null;
  files: string[];
  status: "open" | "fixed" | "wontfix";
};

export type NewIssue = {
  title: string;
  detail?: string | null;
  severity?: Severity;
  /** the files a fix should touch — empty means "locate it yourself" */
  files?: string[];
};

/** Write the defects a stage found. Returns the blocking count. */
export async function recordIssues(
  runId: string,
  iteration: number,
  source: "verify" | "test",
  issues: NewIssue[],
): Promise<{ total: number; blocking: number }> {
  if (issues.length === 0) return { total: 0, blocking: 0 };

  await db.insert(runIssues).values(
    issues.map((issue) => ({
      runId,
      iteration,
      source,
      severity: issue.severity ?? "major",
      title: issue.title.slice(0, 300),
      detail: issue.detail ?? null,
      files: issue.files ?? [],
    })),
  );

  return {
    total: issues.length,
    blocking: issues.filter((i) => (i.severity ?? "major") !== "minor").length,
  };
}

/** Everything still open for a run, oldest first. */
export async function openIssues(runId: string): Promise<RunIssue[]> {
  const rows = await db
    .select()
    .from(runIssues)
    .where(and(eq(runIssues.runId, runId), eq(runIssues.status, "open")))
    .orderBy(asc(runIssues.createdAt));

  return rows.map((r) => ({
    id: r.id,
    iteration: r.iteration,
    source: r.source as "verify" | "test",
    severity: r.severity as Severity,
    title: r.title,
    detail: r.detail,
    files: (r.files as string[] | null) ?? [],
    status: r.status as RunIssue["status"],
  }));
}

export async function markFixed(runId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(runIssues)
    .set({ status: "fixed" })
    .where(and(eq(runIssues.runId, runId), inArray(runIssues.id, ids)))
    .returning({ id: runIssues.id });
  return rows.length;
}

/** Issue counts by severity, for the run header and the quality score. */
export async function issueCounts(
  runId: string,
): Promise<{ open: number; critical: number; byIteration: Record<number, number> }> {
  const rows = await db.execute(sql`
    select severity, iteration, count(*)::int as n
      from run_issues
     where run_id = ${runId} and status = 'open'
     group by severity, iteration
  `);

  let open = 0;
  let critical = 0;
  const byIteration: Record<number, number> = {};
  for (const row of rows as unknown as { severity: string; iteration: number; n: number }[]) {
    open += row.n;
    if (row.severity === "critical") critical += row.n;
    byIteration[row.iteration] = (byIteration[row.iteration] ?? 0) + row.n;
  }
  return { open, critical, byIteration };
}
