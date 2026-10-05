import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { currentUserId } from "@/lib/ai/context";
import { workspaceDir, listFiles } from "./workspace";
import { resolveInfraToken } from "./settings";

/* Deploy — production deploys to the user's own hosting, never ours.

   Default: Vercel (v13 Deployments API, inline files — the workspace is
   uploaded straight from disk, no git round-trip needed).
   Fallback: Render web service from the GitHub repo, when a Render key and a
   GitHub repo both exist and Vercel failed.

   Token resolution (first that exists wins), the same pattern as GitHub:
     1. the run owner's connected Vercel token (Settings → Connections, so
        builds host on THEIR account)
     2. VERCEL_TOKEN env (+ VERCEL_TEAM_ID)
     3. the admin-supplied token in Admin → Infrastructure

   The run owner comes from the pipeline's user scope (AsyncLocalStorage),
   so no agent has to thread a userId down to the deploy stage. */

export type DeployEnv = Record<string, string>;

const SKIP = new Set(["node_modules", ".git", ".next", ".vercel", ".turbo"]);

function collectFiles(runId: string): { file: string; data: string; encoding: "base64" }[] {
  const base = workspaceDir(runId);
  const files = listFiles(runId).filter((p) => !p.endsWith("/"));
  const out: { file: string; data: string; encoding: "base64" }[] = [];
  for (const rel of files) {
    const parts = rel.split("/");
    if (parts.some((p) => SKIP.has(p))) continue;
    const buf = readFileSync(join(base, rel));
    out.push({ file: rel, data: buf.toString("base64"), encoding: "base64" });
  }
  return out;
}

export type VercelConnection = {
  token: string;
  teamId: string | null;
  /** verified Vercel username when known */
  account: string | null;
  source: "user" | "platform";
};

/** The run owner's connected token (Settings → Connections). */
async function userVercelConnection(userId: string | null): Promise<VercelConnection | null> {
  if (!userId) return null;
  try {
    const [row] = await db
      .select({ token: users.vercelTokenEncrypted, teamId: users.vercelTeamId, account: users.vercelAccount })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row?.token) return null;
    const token = decryptSecret(row.token);
    if (!token) return null;
    return { token, teamId: row.teamId ?? null, account: row.account ?? null, source: "user" };
  } catch {
    return null; // an unreadable connection must not fail a deploy — fall through
  }
}

/** Operator-level capacity: env first, then Admin → Infrastructure. */
async function platformVercelConnection(): Promise<VercelConnection | null> {
  const env = process.env.VERCEL_TOKEN?.trim();
  if (env) {
    return { token: env, teamId: process.env.VERCEL_TEAM_ID?.trim() || null, account: null, source: "platform" };
  }
  try {
    const admin = await resolveInfraToken("vercel");
    if (admin) return { token: admin, teamId: null, account: null, source: "platform" };
  } catch {
    /* db unavailable — treat as absent */
  }
  return null;
}

/** Deploy token resolution for a run: the owner's own Vercel, else the platform's. */
export async function vercelConnectionForUser(userId: string | null): Promise<VercelConnection | null> {
  return (await userVercelConnection(userId)) ?? (await platformVercelConnection());
}

/** Non-secret view for the Settings page. */
export async function vercelConnectionStatus(
  userId: string | null,
): Promise<{ connected: boolean; account: string | null; source: "user" | "platform" | null }> {
  const own = await userVercelConnection(userId);
  if (own) return { connected: true, account: own.account, source: "user" };
  const platform = await platformVercelConnection();
  return platform
    ? { connected: true, account: platform.account, source: "platform" }
    : { connected: false, account: null, source: null };
}

/** Check a candidate token against /v2/user before storing it. */
export async function verifyVercelToken(
  token: string,
): Promise<{ ok: true; username: string | null } | { ok: false; error: string }> {
  try {
    const res = await fetch("https://api.vercel.com/v2/user", {
      headers: { authorization: "Bearer " + token },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 160);
      try {
        msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
      } catch {
        /* keep raw */
      }
      return { ok: false, error: `Vercel rejected the token (HTTP ${res.status}) — ${msg}` };
    }
    const j = JSON.parse(text) as { user?: { username?: string; email?: string } };
    return { ok: true, username: j.user?.username ?? j.user?.email?.split("@")[0] ?? null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 160) : "Could not reach Vercel" };
  }
}

export async function saveVercelConnection(
  userId: string,
  token: string,
  teamId: string | null,
  account: string | null,
): Promise<void> {
  await db
    .update(users)
    .set({
      vercelTokenEncrypted: encryptSecret(token),
      vercelTeamId: teamId?.trim() || null,
      vercelAccount: account,
    })
    .where(eq(users.id, userId));
}

export async function clearVercelConnection(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ vercelTokenEncrypted: null, vercelTeamId: null, vercelAccount: null })
    .where(eq(users.id, userId));
}

function teamQuery(teamId: string | null): string {
  return teamId ? "?teamId=" + encodeURIComponent(teamId) : "";
}

export type DeployResult = {
  url: string;
  inspectUrl: string | null;
  provider: "vercel" | "render";
};

/* A remote build failure is not a dead end — it is a build log the coder can
   fix from, exactly like a local failure. Vercel reports only "Command \"npm
   run build\" exited with 1", so the useful part lives in the deployment's
   build events: those have to be fetched separately and handed back to the
   fix loop. This marks the error so the orchestrator knows the failure is
   repairable code and how to reach its log. */
export class RemoteBuildError extends Error {
  readonly deploymentId: string;
  constructor(message: string, deploymentId: string) {
    super(message);
    this.name = "RemoteBuildError";
    this.deploymentId = deploymentId;
  }
}

/** Pull the compressed build log of a failed deployment as plain text. */
export async function fetchVercelBuildLog(deploymentId: string): Promise<string> {
  const conn = await vercelConnectionForUser(currentUserId());
  if (!conn) return "";
  try {
    const res = await fetch(
      "https://api.vercel.com/v3/deployments/" + deploymentId + "/events?builds=1&direction=forward" + teamQuery(conn.teamId),
      { headers: { authorization: "Bearer " + conn.token }, cache: "no-store" },
    );
    if (!res.ok) return "";
    const body = await res.text();
    const out: string[] = [];
    for (const line of body.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { type?: string; payload?: { text?: string }; text?: string };
        const t = e.payload?.text ?? e.text ?? "";
        if (t) out.push(t);
      } catch {
        /* keep-alive or partial line */
      }
    }
    /* the useful part of a Next build log is the tail: the failing module,
       the error, and the exit status */
    return out.slice(-120).join("\n");
  } catch {
    return "";
  }
}

export async function deployToVercel(
  runId: string,
  opts: { projectName: string; env: DeployEnv; onLine: (line: string) => Promise<void> | void },
): Promise<DeployResult> {
  /* the run owner's Vercel when connected, else the operator's — deploy runs
     inside the pipeline's user scope, so the owner resolves here */
  const conn = await vercelConnectionForUser(currentUserId());
  if (!conn)
    throw new Error(
      "no Vercel token — connect Vercel in Settings (or the operator adds VERCEL_TOKEN) before runs can ship",
    );

  const files = collectFiles(runId);
  if (files.length === 0) throw new Error("workspace has no deployable files");
  await opts.onLine(`-> packaging ${files.length} files for vercel`);

  const created = await fetch("https://api.vercel.com/v13/deployments" + teamQuery(conn.teamId), {
    method: "POST",
    headers: { authorization: "Bearer " + conn.token, "content-type": "application/json" },
    body: JSON.stringify({
      name: opts.projectName,
      target: "production",
      files,
      projectSettings: { framework: "nextjs" },
      env: opts.env,
      build: { env: opts.env },
    }),
    cache: "no-store",
  });
  const raw = await created.text();
  if (!created.ok) {
    throw new Error("vercel rejected the deploy (" + created.status + "): " + raw.replace(/\s+/g, " ").slice(0, 220));
  }
  const dep = JSON.parse(raw) as { id: string; url?: string; readyState?: string };

  // poll until the build finishes — real states only, printed as they change.
  // Free-tier builds queue behind a 2-core shared machine and every deploy of a
  // fresh project installs and builds from a cold cache, so a patient deadline
  // is the difference between "deployed" and a false "deploy failed". A run
  // once went READY eleven minutes in, AFTER the old 12-minute deadline had
  // already failed the pipeline — Vercel's own dashboard showed the site live
  // while the run page said the deploy had died. The deadline is therefore
  // generous, tunable, and on expiry the deployment is re-checked once before
  // giving up, because the two most common states at that moment are exactly
  // the ones worth not lying about.
  const timeoutMin = Math.max(5, Number(process.env.VERCEL_BUILD_TIMEOUT_MINUTES ?? 25));
  const deadline = Date.now() + timeoutMin * 60_000;
  let lastState = dep.readyState ?? "QUEUED";
  let lastBeat = Date.now();
  await opts.onLine("-> building on vercel (" + lastState.toLowerCase() + ")");
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await fetch("https://api.vercel.com/v13/deployments/" + dep.id + teamQuery(conn.teamId), {
      headers: { authorization: "Bearer " + conn.token },
      cache: "no-store",
    });
    if (!poll.ok) throw new Error("vercel poll failed: " + poll.status);
    const state = (await poll.json()) as {
      readyState: string;
      url?: string;
      alias?: string[];
      errorMessage?: string;
    };
    if (state.readyState !== lastState) {
      lastState = state.readyState;
      lastBeat = Date.now();
      await opts.onLine("-> " + lastState.toLowerCase() + " (" + elapsedMin(deadline - timeoutMin * 60_000) + " in)");
    } else if (Date.now() - lastBeat > 60_000) {
      /* a quiet minute is normal (install, compile, upload) but the run page
         must show the poller is alive, not frozen */
      lastBeat = Date.now();
      await opts.onLine("-> still " + lastState.toLowerCase() + " — " + elapsedMin(deadline - timeoutMin * 60_000) + " elapsed (vercel free tier queues builds)");
    }
    if (state.readyState === "READY") {
      const url = (state.alias?.[0] ?? state.url ?? "").replace(/^https?:\/\//, "");
      if (!url) throw new Error("vercel reported READY without a URL");
      return { url: "https://" + url, inspectUrl: "https://vercel.com/deployments/" + dep.id, provider: "vercel" };
    }
    if (state.readyState === "ERROR" || state.readyState === "CANCELED") {
      /* a build that ran and failed is repairable code, so the error carries
         the deployment id and the orchestrator can fetch the real log */
      const detail = state.errorMessage ?? "no error detail returned";
      const isBuildFailure = /build|npm run build|exited with|Command/i.test(detail);
      if (isBuildFailure && state.readyState === "ERROR") {
        throw new RemoteBuildError("vercel build failed: " + detail, dep.id);
      }
      throw new Error("vercel build " + state.readyState.toLowerCase() + ": " + detail);
    }
  }
  /* deadline hit — re-check once before reporting, so a deployment that went
     READY in the final seconds is not declared dead */
  const final = await fetch("https://api.vercel.com/v13/deployments/" + dep.id + teamQuery(conn.teamId), {
    headers: { authorization: "Bearer " + conn.token },
    cache: "no-store",
  });
  if (final.ok) {
    const state = (await final.json()) as { readyState: string; url?: string; alias?: string[] };
    if (state.readyState === "READY") {
      const url = (state.alias?.[0] ?? state.url ?? "").replace(/^https?:\/\//, "");
      if (url) return { url: "https://" + url, inspectUrl: "https://vercel.com/deployments/" + dep.id, provider: "vercel" };
    }
  }
  throw new Error(
    "vercel still building after " + timeoutMin + " minutes — the deploy is NOT failed, it is queued/slow on vercel's free tier. Track it at https://vercel.com/deployments/" + dep.id,
  );
}

/** Whole minutes since `start`, for the heartbeat lines. */
function elapsedMin(start: number): string {
  return Math.max(1, Math.round((Date.now() - start) / 60_000)) + "m";
}

/* ———————————————————————— render fallback ———————————————————————— */

async function renderToken(): Promise<string | null> {
  return process.env.RENDER_API_KEY?.trim() || resolveInfraToken("render");
}

export async function deployToRender(
  repo: { owner: string; name: string },
  opts: { projectName: string; env: DeployEnv; onLine: (line: string) => Promise<void> | void },
): Promise<DeployResult> {
  const token = await renderToken();
  if (!token) throw new Error("no Render key — set RENDER_API_KEY to enable the render fallback");

  await opts.onLine("-> creating render web service from the github repo");
  const res = await fetch("https://api.render.com/v1/services", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({
      type: "web",
      name: opts.projectName,
      repo: "https://github.com/" + repo.owner + "/" + repo.name,
      autoDeploy: "no",
      rootDir: null,
      serviceDetails: {
        runtime: "node",
        plan: "free",
        region: "oregon",
        buildCommand: "npm install && npm run build",
        startCommand: "npm run start",
        envVars: Object.entries(opts.env).map(([key, value]) => ({ key, value })),
        healthCheckPath: "/api/health",
      },
    }),
    cache: "no-store",
  });
  const raw = await res.text();
  if (!res.ok) throw new Error("render service create failed (" + res.status + "): " + raw.replace(/\s+/g, " ").slice(0, 220));
  const svc = JSON.parse(raw) as { id: string; serviceDetails?: { url?: string } };

  const trig = await fetch(`https://api.render.com/v1/services/${svc.id}/deploys`, {
    method: "POST",
    headers: { authorization: "Bearer " + token },
    cache: "no-store",
  });
  if (!trig.ok) throw new Error("render deploy trigger failed: " + trig.status);

  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8000));
    const poll = await fetch(`https://api.render.com/v1/services/${svc.id}/deploys?limit=1`, {
      headers: { authorization: "Bearer " + token },
      cache: "no-store",
    });
    if (!poll.ok) throw new Error("render poll failed: " + poll.status);
    const rows = (await poll.json()) as { deploy?: { status: string } }[];
    const status = rows[0]?.deploy?.status;
    if (status === "live") {
      const url = svc.serviceDetails?.url ?? "https://" + opts.projectName + ".onrender.com";
      return { url, inspectUrl: "https://dashboard.render.com/web/" + svc.id, provider: "render" };
    }
    if (status === "build_failed" || status === "update_failed" || status === "canceled") {
      throw new Error("render deploy " + status.replace(/_/g, " "));
    }
  }
  throw new Error("render deploy timed out after 15 minutes");
}

/** Directory sizes for the honest "what will this cost" log line. */
export function workspaceStats(runId: string): { files: number; bytes: number } {
  const base = workspaceDir(runId);
  let files = 0;
  let bytes = 0;
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry) || entry.startsWith(".")) continue;
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else {
        files++;
        bytes += statSync(abs).size;
      }
    }
  }
  walk(base);
  return { files, bytes };
}
