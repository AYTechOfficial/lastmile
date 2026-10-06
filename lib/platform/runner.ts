/* Waking the runner.

   The dashboard does not execute pipeline work — it queues it and then asks
   GitHub to start a runner. This module is that ask.

   Two properties matter:

     · It NEVER throws. A dispatch failure means the job sits in the queue until
       the scheduled poll picks it up. Failing a user's run because a webhook
       call failed would be the wrong trade — the queue is the source of truth,
       dispatch is only an optimisation for latency.
     · It is a no-op when the runner is not configured, which is the normal case
       during local development, where you claim jobs with
       `npx tsx runner/index.mts` instead. */

const API = "https://api.github.com";

export type DispatchInput = {
  /** run the specific job now, rather than letting the runner poll */
  jobId?: string;
};

export function runnerConfigured(): boolean {
  return Boolean(
    process.env.RUNNER_REPO?.trim() &&
      (process.env.RUNNER_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()),
  );
}

/** POST a workflow_dispatch at the platform repo's runner workflow.
    Fire-and-forget by design; the caller awaits it only to keep ordering tidy. */
export async function dispatchRunner(input: DispatchInput = {}): Promise<boolean> {
  const repo = process.env.RUNNER_REPO?.trim(); // "owner/name"
  const token = (process.env.RUNNER_TOKEN ?? process.env.GITHUB_TOKEN ?? "").trim();
  const workflow = process.env.RUNNER_WORKFLOW?.trim() || "runner.yml";
  const ref = process.env.RUNNER_REF?.trim() || "main";

  if (!repo || !token) return false;

  try {
    const res = await fetch(`${API}/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref,
        inputs: input.jobId ? { job_id: input.jobId } : {},
      }),
      /* A dispatch endpoint that accepts the request answers 204. Anything
         slower than this is not worth blocking a user's redirect on. */
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      console.error("runner dispatch rejected", { status: res.status, repo, workflow });
      return false;
    }
    return true;
  } catch (error) {
    console.error("runner dispatch failed", { repo, workflow, error });
    return false;
  }
}

/** How many runner workflow runs GitHub currently considers awake or waiting.

    The sweep asks this instead of inferring it from the database, because the
    two disagree in the one window that matters: between dispatching a workflow
    run and that runner claiming a job, the `jobs` table shows nothing running,
    so a lease-based check would dispatch again and again.

    Returns `null` when GitHub cannot be asked — the caller then falls back to
    what the database can see. Nothing here throws, for the same reason
    `dispatchRunner` does not: this is an optimisation, never a gate on truth. */
export async function runnerWorkflowRunsInFlight(): Promise<number | null> {
  const repo = process.env.RUNNER_REPO?.trim();
  const token = (process.env.RUNNER_TOKEN ?? process.env.GITHUB_TOKEN ?? "").trim();
  const workflow = process.env.RUNNER_WORKFLOW?.trim() || "runner.yml";

  if (!repo || !token) return null;

  const AWAKE = new Set(["queued", "in_progress", "requested", "waiting", "pending"]);

  try {
    const res = await fetch(
      `${API}/repos/${repo}/actions/workflows/${workflow}/runs?per_page=20`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!res.ok) {
      console.error("runner run list rejected", { status: res.status, repo, workflow });
      return null;
    }

    const data = (await res.json()) as { workflow_runs?: { status?: string }[] };
    return (data.workflow_runs ?? []).filter((r) => AWAKE.has(String(r.status))).length;
  } catch (error) {
    console.error("runner run list failed", { repo, workflow, error });
    return null;
  }
}
