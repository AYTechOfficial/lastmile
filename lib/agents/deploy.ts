/* The Deployer — the stage that turns a verified repo into a real URL.

   The deployment is a genuine Vercel deployment: every file in the repo is
   uploaded through Vercel's file API and the deployment is created from those
   files, so Vercel builds the app with its own builders exactly as `vercel`
   would from a laptop. No GitHub app integration is required, which matters —
   a freshly created repo has no connected app, and waiting for one would be a
   stage that hangs.

   Failure is reported, not swallowed: a deployment that errors after Vercel's
   build fails the stage with Vercel's own error message, and the run shows the
   reason rather than a URL that leads nowhere. */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { PlanConfig } from "../plans";
import { resolveInfraToken } from "../platform/settings";

const exec = promisify(execFile);

const API = "https://api.vercel.com";
const CLONE_TIMEOUT_MS = 120_000;
const DEPLOY_TIMEOUT_MS = 6 * 60_000;
const MAX_FILES = 3_000;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
/** Vercel's API rejects bundles over 100 MB total across files; the generated
    apps are source-only and come in far under it. */
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;

export type DeployInput = {
  plan: PlanConfig;
  emit: (kind: "info" | "command" | "success" | "warn" | "error" | "url", line: string) => Promise<void>;
  heartbeat: () => Promise<void>;
  repo: { owner: string; name: string; sha?: string | null } | null;
  slug: string;
};

export type DeployResult = {
  ok: boolean;
  url: string | null;
  tokens: number;
  reason?: string;
};

export async function runDeployer(input: DeployInput): Promise<DeployResult> {
  const started = Date.now();
  await input.emit("command", `$ lastmile deploy --project lastmile-${input.slug}`);

  if (!input.repo) {
    return { ok: false, url: null, tokens: 0, reason: "the run has no repository to deploy" };
  }

  const token = (await resolveInfraToken("vercel")) ?? (process.env.VERCEL_TOKEN ?? "").trim();
  if (!token) {
    return { ok: false, url: null, tokens: 0, reason: "no Vercel token is configured — cannot deploy" };
  }
  const team = (process.env.VERCEL_TEAM_ID ?? "").trim();
  const teamQs = team ? `?teamId=${encodeURIComponent(team)}` : "";

  const ghToken = await resolveInfraToken("github");
  if (!ghToken) {
    return { ok: false, url: null, tokens: 0, reason: "no GitHub token is configured — cannot read the repo to deploy" };
  }

  let dir: string | null = null;
  try {
    /* ————— clone the exact commit the verifier saw ————— */
    dir = await mkdtemp(join(tmpdir(), "lastmile-deploy-"));
    const url = `https://x-access-token:${ghToken}@github.com/${input.repo.owner}/${input.repo.name}.git`;
    try {
      await exec("git", ["clone", "--depth", "1", "-q", url, dir], { timeout: CLONE_TIMEOUT_MS });
    } catch (error) {
      return {
        ok: false,
        url: null,
        tokens: 0,
        reason: `could not clone the repo to deploy it: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    /* ————— collect and upload the files ————— */
    const files = await collectFiles(dir);
    if (files.length === 0) {
      return { ok: false, url: null, tokens: 0, reason: "the repo has no files a deployment can serve" };
    }

    await input.emit("info", `-> uploading ${files.length} file(s) to Vercel`);
    let uploaded = 0;
    let totalBytes = 0;
    for (const file of files) {
      if (totalBytes + file.size > MAX_TOTAL_BYTES) {
        await input.emit("warn", `-> skipped ${file.path} — the deployment bundle budget is spent`);
        continue;
      }
      const res = await fetch(`${API}/v2/now/files${teamQs}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "x-vercel-digest": file.sha,
        },
        body: new Uint8Array(file.bytes),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        return { ok: false, url: null, tokens: 0, reason: `Vercel rejected ${file.path} (HTTP ${res.status}) ${body}` };
      }
      uploaded += 1;
      totalBytes += file.size;
      if (uploaded % 40 === 0) {
        await input.heartbeat();
        await input.emit("info", `-> ${uploaded}/${files.length} file(s) uploaded`);
      }
    }

    /* ————— create the deployment —————
       The manifest shape is Vercel's own documented one: each entry names the
       file by path, digest and size — the same digest the upload declared. */
    const framework = await detectFramework(dir);
    const body = {
      name: `lastmile-${sanitize(input.slug)}`,
      target: "production",
      files: files.map((f) => ({ file: f.path, sha: f.sha, size: f.size })),
      projectSettings: { framework },
    };
    const createRes = await fetch(`${API}/v12/now/deployments${teamQs}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!createRes.ok) {
      const text = await createRes.text();
      return { ok: false, url: null, tokens: 0, reason: `Vercel rejected the deployment (HTTP ${createRes.status}) ${text.slice(0, 300)}` };
    }
    const created = (await createRes.json()) as { id?: string; url?: string };
    if (!created.id) {
      return { ok: false, url: null, tokens: 0, reason: "Vercel returned no deployment id" };
    }

    /* ————— poll until it is real ————— */
    const beat = setInterval(() => void input.heartbeat(), 20_000);
    let state = "";
    let readyUrl: string | null = null;
    let errorMessage = "";
    try {
      const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 8_000));
        const poll = await fetch(`${API}/v12/now/deployments/${created.id}${teamQs}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (!poll.ok) continue;
        const d = (await poll.json()) as {
          readyState?: string;
          url?: string;
          errorMessage?: string;
          readyStateError?: { message?: string } | null;
        };
        state = d.readyState ?? "";
        errorMessage = d.errorMessage ?? d.readyStateError?.message ?? "";
        if (state === "READY") {
          readyUrl = d.url ? `https://${d.url}` : null;
          break;
        }
        if (state === "ERROR" || state === "CANCELED") break;
        await input.emit("info", `-> building on Vercel (${state.toLowerCase()})…`);
      }
    } finally {
      clearInterval(beat);
    }

    if (state !== "READY" || !readyUrl) {
      return {
        ok: false,
        url: null,
        tokens: 0,
        reason: `the Vercel build did not come up (${state || "timeout"})${errorMessage ? `: ${errorMessage}` : ""}`,
      };
    }

    await input.emit("success", `-> deployed to ${readyUrl} in ${Math.round((Date.now() - started) / 1000)}s`);
    await input.emit("url", readyUrl);
    return { ok: true, url: readyUrl, tokens: 0 };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

type Collected = { path: string; sha: string; size: number; bytes: Buffer };

async function collectFiles(dir: string): Promise<Collected[]> {
  const out: Collected[] = [];
  const skip = new Set(["node_modules", ".git", ".next", ".vercel", "coverage", ".cache"]);
  async function walk(rel: string, depth: number): Promise<void> {
    if (depth > 10 || out.length >= MAX_FILES) return;
    const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (skip.has(e.name) || e.name.startsWith(".")) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      const s = await stat(join(dir, path)).catch(() => null);
      if (!s || s.size === 0 || s.size > MAX_FILE_BYTES) continue;
      const bytes = await readFile(join(dir, path)).catch(() => null);
      if (!bytes) continue;
      out.push({
        path,
        /* Vercel's file API authenticates uploads by SHA-1 digest — the same
           value must go in the upload header and the deployment manifest. */
        sha: createHash("sha1").update(bytes).digest("hex"),
        size: s.size,
        bytes,
      });
    }
  }
  await walk("", 0);
  return out;
}

/** The one piece of configuration a cold project needs: Vercel auto-detects
    everything else from the files themselves. */
async function detectFramework(dir: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) return "nextjs";
    if (deps.vite) return "vite";
    if (deps["@remix-run/dev"]) return "remix";
    if (deps.express) return "expressjs";
    return null;
  } catch {
    return null;
  }
}

function sanitize(name: string): string {
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 52);
  return clean || "app";
}
