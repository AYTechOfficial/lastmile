import { db } from "@/lib/db";
import { accounts } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { resolveInfraToken } from "./settings";

/* GitHub — repository creation and versioned commits through the REST API.

   Token resolution, first that exists wins:
     1. the signed-in user's own GitHub OAuth link (they connected it in
        Settings, so repos land in THEIR account — never a platform repo)
     2. GITHUB_TOKEN env
     3. the admin-supplied token in platform settings

   Commits are built with the Git Data API (blobs → tree → commit → ref), so a
   40-file build is ONE commit with a real message, not 40 noise commits. */

export type GithubFile = { path: string; content: string };

const API = "https://api.github.com";

async function gh<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const res = await fetch(API + path, {
    method: init?.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "user-agent": "lastmile-pipeline",
      ...(init?.body ? {} : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 220);
    try {
      msg = (JSON.parse(text) as { message?: string }).message ?? msg;
    } catch {
      /* keep raw */
    }
    return { ok: false, status: res.status, error: `github ${res.status}: ${msg}` };
  }
  if (!text) return { ok: true, data: {} as T };
  return { ok: true, data: JSON.parse(text) as T };
}

/** The user's linked token, refreshed from the accounts table on every call. */
export async function githubTokenForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ token: accounts.access_token })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  if (row?.token) return row.token;
  const env = process.env.GITHUB_TOKEN?.trim();
  if (env) return env;
  return resolveInfraToken("github");
}

export type RepoInfo = { owner: string; name: string; url: string; htmlUrl: string };

export async function createRepo(
  token: string,
  opts: { name: string; description: string; isPrivate: boolean },
): Promise<RepoInfo> {
  const created = await gh<{ owner: { login: string }; name: string; full_name: string; html_url: string; url: string }>(
    token,
    "/user/repos",
    { method: "POST", body: { name: opts.name, description: opts.description.slice(0, 300), private: opts.isPrivate, auto_init: false, has_issues: true } },
  );
  if (!created.ok) {
    if (created.status === 422) throw new Error("a repository named '" + opts.name + "' already exists on your GitHub account — delete it or rename this run");
    throw new Error(created.error);
  }
  const r = created.data;
  return { owner: r.owner.login, name: r.name, url: r.url, htmlUrl: r.html_url };
}

type TreeEntry = { path: string; mode: "100644"; type: "blob"; content: string };

/** One commit with every file — this is what keeps the history clean. */
export async function commitFiles(
  token: string,
  repo: { owner: string; name: string },
  files: GithubFile[],
  message: string,
): Promise<{ commitSha: string }> {
  // 1. resolve the current head (absent on a fresh repo)
  const ref = await gh<{ object: { sha: string } }>(token, `/repos/${repo.owner}/${repo.name}/git/ref/heads/main`);
  const parentSha = ref.ok ? ref.data.object.sha : null;

  // 2. one tree with all files inline
  const tree = await gh<{ sha: string }>(token, `/repos/${repo.owner}/${repo.name}/git/trees`, {
    method: "POST",
    body: {
      tree: files.map<TreeEntry>((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
    },
  });
  if (!tree.ok) throw new Error(tree.error);

  // 3. the commit
  const commit = await gh<{ sha: string }>(token, `/repos/${repo.owner}/${repo.name}/git/commits`, {
    method: "POST",
    body: { message, tree: tree.data.sha, parents: parentSha ? [parentSha] : [] },
  });
  if (!commit.ok) throw new Error(commit.error);

  // 4. move the branch
  if (parentSha) {
    const patched = await gh(token, `/repos/${repo.owner}/${repo.name}/git/refs/heads/main`, {
      method: "PATCH",
      body: { sha: commit.data.sha, force: true },
    });
    if (!patched.ok) throw new Error(patched.error);
  } else {
    const created = await gh(token, `/repos/${repo.owner}/${repo.name}/git/refs`, {
      method: "POST",
      body: { ref: "refs/heads/main", sha: commit.data.sha },
    });
    if (!created.ok) throw new Error(created.error);
  }

  return { commitSha: commit.data.sha };
}

/* ————————— restoring a workspace from the repo —————————

   Once a run ships, the platform releases its local copy of the code (the
   repo is the source of truth). An iteration on that run then has to pull
   the code back before the coder can touch it — reading the repo's tree
   through the same API the push wrote. */

/** "https://github.com/owner/name" → { owner, name } (null when not a repo URL). */
export function parseRepoUrl(url: string | null): { owner: string; name: string } | null {
  if (!url) return null;
  const m = url.replace(/\/+$/, "").match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  return { owner: m[1], name: m[2].replace(/\.git$/, "") };
}

/** Refill a run's workspace from the repo's default branch.
 *  Returns the number of files restored; 0 when the repo is unreachable. */
export async function restoreWorkspaceFromGithub(
  token: string,
  repo: { owner: string; name: string },
  runId: string,
): Promise<number> {
  const branch = await gh<{ object: { sha: string } }>(token, `/repos/${repo.owner}/${repo.name}/git/ref/heads/main`);
  let head: string | null = branch.ok ? branch.data.object.sha : null;
  if (!head) {
    const master = await gh<{ object: { sha: string } }>(token, `/repos/${repo.owner}/${repo.name}/git/ref/heads/master`);
    if (master.ok) head = master.data.object.sha;
  }
  if (!head) return 0;

  const tree = await gh<{ tree: { path: string; type: string; sha: string; size?: number }[] }>(
    token,
    `/repos/${repo.owner}/${repo.name}/git/trees/${head}?recursive=1`,
  );
  if (!tree.ok) return 0;

  const blobs = tree.data.tree.filter((e) => e.type === "blob" && (e.size ?? 0) <= 1_000_000);
  const { writeFiles } = await import("./workspace");
  let restored = 0;
  for (const entry of blobs) {
    const blob = await gh<{ content?: string; encoding?: string }>(
      token,
      `/repos/${repo.owner}/${repo.name}/git/blobs/${entry.sha}`,
    );
    if (!blob.ok || blob.data.encoding !== "base64" || !blob.data.content) continue;
    const content = Buffer.from(blob.data.content, "base64").toString("utf8");
    writeFiles(runId, [{ path: entry.path, content }]);
    restored++;
  }
  return restored;
}
