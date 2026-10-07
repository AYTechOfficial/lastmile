/* The Verifier — the stage that stands between "the model wrote code" and
   "the code is worth shipping".

   Three checks, in descending order of honesty:

     1. A REAL BUILD. The repo is cloned onto the runner and actually built —
        `npm ci && npm run build` with a hard cap. A generated app that cannot
        compile does not get a link, no matter how confident the model sounded.
        This is the check that catches most defects, and it is the one no
        amount of model self-report can replace.

     2. A STRUCTURAL SWEEP. Every route the spec promised must plausibly exist
        on disk, and the classic placeholders ("TODO", "lorem", empty pages)
        are looked for directly. Cheap, deterministic, and immune to a model
        having a confident day.

     3. A MODEL REVIEW of the code against the master prompt — the only check
        that can say "the login flow does not match what was specified". It
        runs last and its verdict is blended with the build's, so a model that
        is down degrades the verification rather than ending it.

   Everything it finds goes into the defect ledger with the files a fix round
   should touch. `blocking > 0` is what sends a run back to the coder. */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { chatJson, defaultModelFor, type ChatInput } from "../ai/chat";
import type { MasterBuildPrompt, ProductSpec } from "../domain";
import type { NewIssue } from "../pipeline/issues";
import type { PlanConfig } from "../plans";
import { resolveInfraToken } from "../platform/settings";

const exec = promisify(execFile);

export type VerifyInput = {
  plan: PlanConfig;
  userId: string;
  preferredModel: string | null;
  master: MasterBuildPrompt | null;
  spec: ProductSpec | null;
  repo: { owner: string; name: string } | null;
  iteration: number;
  emit: (kind: "info" | "command" | "success" | "warn" | "error" | "url", line: string) => Promise<void>;
  heartbeat: () => Promise<void>;
};

export type VerifyResult = {
  ok: boolean;
  usable: boolean;
  issues: NewIssue[];
  score: number;
  built: boolean;
  tokens: number;
  reason?: string;
};

const BUILD_CAP_MS = 6 * 60_000;
const MAX_FILES_IN_PROMPT = 120;
const KEY_FILE_BYTES = 6_000;

/** Which files a fix round should look at first — the ones a build tool or a
    human would open. The model review names files too; this is the fallback. */
const KEY_FILES = [
  "package.json",
  "app/page.tsx",
  "pages/index.tsx",
  "src/App.tsx",
  "src/app/page.tsx",
  "index.html",
  "next.config.js",
  "next.config.mjs",
  "vite.config.ts",
];

export async function runVerifier(input: VerifyInput): Promise<VerifyResult> {
  const started = Date.now();
  await input.emit("command", `$ lastmile verify --iteration ${input.iteration}`);

  if (!input.repo) {
    return {
      ok: false,
      usable: false,
      issues: [],
      score: 0,
      built: false,
      tokens: 0,
      reason: "the run has no repository to verify — the code stage never landed",
    };
  }

  const token = await resolveInfraToken("github");
  if (!token) {
    return {
      ok: false,
      usable: false,
      issues: [],
      score: 0,
      built: false,
      tokens: 0,
      reason: "no GitHub token is configured — the verifier cannot read the repo",
    };
  }

  const issues: NewIssue[] = [];
  let built = false;
  let buildScore = 50;
  let tokens = 0;
  let dir: string | null = null;

  try {
    /* ————— 1. clone ————— */
    dir = await mkdtemp(join(tmpdir(), "lastmile-verify-"));
    const url = `https://x-access-token:${token}@github.com/${input.repo.owner}/${input.repo.name}.git`;
    try {
      await exec("git", ["clone", "--depth", "1", "-q", url, dir], { timeout: 120_000 });
      await input.emit("info", `-> cloned ${input.repo.owner}/${input.repo.name}`);
    } catch (error) {
      return {
        ok: false,
        usable: false,
        issues: [],
        score: 0,
        built: false,
        tokens,
        reason: `could not clone the repo: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    /* ————— 2. the real build ————— */
    const pkgRaw = await readFileSafe(join(dir, "package.json"));
    if (pkgRaw) {
      let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string> } = {};
      try {
        pkg = JSON.parse(pkgRaw) as typeof pkg;
      } catch {
        issues.push({
          title: "package.json is not valid JSON",
          detail: "The build tooling could not parse it, which means every later step is guesswork.",
          severity: "critical",
          files: ["package.json"],
        });
      }

      const hasLock = await exists(join(dir, "package-lock.json"));
      const buildScript = pkg.scripts?.build;

      if (buildScript) {
        await input.emit("info", "-> building the generated app for real (npm) — this is the part that catches most defects");
        const beat = setInterval(() => void input.heartbeat(), 20_000);
        try {
          const install = hasLock
            ? await run("npm", ["ci", "--no-audit", "--no-fund"], dir, BUILD_CAP_MS)
            : await run("npm", ["install", "--no-audit", "--no-fund"], dir, BUILD_CAP_MS);
          if (install.code !== 0) {
            buildScore = 15;
            built = false;
            issues.push({
              title: "dependencies do not install",
              detail: excerpt(install.output),
              severity: "critical",
              files: ["package.json"],
            });
            await input.emit("error", "-> npm install failed — see the defect ledger");
          } else {
            const build = await run("npm", ["run", "build"], dir, BUILD_CAP_MS);
            if (build.code === 0) {
              built = true;
              buildScore = 100;
              await input.emit("success", "-> build passed");
            } else {
              built = false;
              buildScore = 25;
              issues.push({
                title: "the app does not compile",
                detail: excerpt(build.output),
                severity: "critical",
                files: namedFiles(build.output),
              });
              await input.emit("error", "-> build failed — this is what the fix round will target");
            }
          }
        } finally {
          clearInterval(beat);
        }
      } else {
        /* A static site with no build step: present is the bar. */
        built = true;
        buildScore = 85;
        await input.emit("info", "-> no build script — verifying as a static site");
      }
    } else {
      built = true;
      buildScore = 70;
      await input.emit("info", "-> no package.json — verifying as a plain file site");
    }

    /* ————— 3. structural sweep ————— */
    const files = await listFiles(dir);
    const routes = input.spec?.routes ?? [];
    let missingRoutes: { path: string; purpose: string }[] = [];

    if (routes.length > 0 && files.some((f) => f === "package.json")) {
      missingRoutes = routes
        .filter((r) => r.path !== "/")
        .filter((r) => !routeHasFile(files, r.path))
        .slice(0, 6);
      for (const r of missingRoutes) {
        issues.push({
          title: `route ${r.path} from the spec has no file behind it`,
          detail: `The spec promised ${r.purpose}, but no page or route file answers ${r.path}.`,
          severity: "major",
          files: [routeGuess(r.path)],
        });
      }
    }

    const placeholders = files
      .filter((f) => /\.(tsx?|jsx?|html|css)$/.test(f))
      .slice(0, 400);
    let placeholderHits = 0;
    for (const f of placeholders) {
      const text = (await readFileSafe(join(dir, f))) ?? "";
      if (/lorem ipsum/i.test(text) || /\bTODO: implement\b/.test(text)) {
        placeholderHits += 1;
        if (placeholderHits <= 3) {
          issues.push({
            title: `placeholder text left in ${f}`,
            detail: "Lorem ipsum or an unimplemented TODO made it into the shipped code.",
            severity: "major",
            files: [f],
          });
        }
      }
    }

    /* ————— 4. the model review ————— */
    let modelScore: number | null = null;
    const chatInput: ChatInput = {
      tier: input.plan.modelTier,
      userId: input.userId,
      agent: "verify",
      preferred: input.preferredModel ?? defaultModelFor(input.plan.modelTier),
      timeoutMs: 120_000,
      maxRungs: 4,
      onAttempt: async (attempt) => {
        if (!attempt.ok) return;
        await input.emit(
          "success",
          `  model ${attempt.provider}/${attempt.model} answered in ${Math.round(attempt.ms / 1000)}s`,
        );
      },
    };

    const review = await chatJson<{ issues?: { title?: string; detail?: string; severity?: string; files?: string[] }[]; score?: number }>(
      chatInput,
      [
        {
          role: "system",
          content:
            "You are a strict code reviewer for a generated web app. You are given the build contract (the master prompt summary), the acceptance spec, and the actual file list with key file excerpts. Find real defects only: missing promised features, broken wiring, obviously dead pages, spec violations. Do NOT invent style complaints. Reply with ONLY JSON: {\"issues\": [{\"title\", \"detail\", \"severity\": \"critical\"|\"major\"|\"minor\", \"files\": [\"path\"]}], \"score\": 0-100}. An empty issues array means clean.",
        },
        {
          role: "user",
          content: [
            input.master
              ? `PRODUCT: ${input.master.productName} — ${input.master.tagline}\nPAGES: ${input.master.pages.map((p) => p.path).join(", ")}\nFEATURES: ${input.master.features.map((f) => `${f.priority}: ${f.name} — ${f.description}`).join("; ")}`
              : "PRODUCT: (master prompt unavailable — judge from the spec)",
            input.spec
              ? `FLOWS AND ACCEPTANCE CRITERIA:\n${input.spec.flows.map((f) => `- ${f.name}: ${f.criteria.join("; ")}`).join("\n")}`
              : "SPEC: unavailable",
            `FILES (${files.length}):\n${files.slice(0, MAX_FILES_IN_PROMPT).join("\n")}`,
            `KEY FILE CONTENTS:\n${await keyFileContents(dir)}`,
            built
              ? "The build PASSED."
              : "The build FAILED — treat compilation as a given defect and focus on what else is wrong.",
          ].join("\n\n"),
        },
      ],
    );
    tokens = review.result.tokens;

    if (review.value && typeof review.value.score === "number") {
      modelScore = Math.max(0, Math.min(100, Math.round(review.value.score)));
      for (const i of (review.value.issues ?? []).slice(0, 10)) {
        const title = (i.title ?? "").trim();
        if (!title) continue;
        const severity = i.severity === "critical" || i.severity === "minor" ? i.severity : "major";
        issues.push({
          title,
          detail: (i.detail ?? "").trim() || null,
          severity,
          files: Array.isArray(i.files) ? i.files.filter((f) => typeof f === "string").slice(0, 5) : [],
        });
      }
      await input.emit(
        "info",
        `-> review found ${review.value.issues?.length ?? 0} concern(s), review score ${modelScore}/100`,
      );
    } else {
      await input.emit(
        "warn",
        "-> model review unavailable — verification stands on the build and structural checks alone",
      );
    }

    /* ————— the score ————— */
    let score = modelScore === null ? buildScore : Math.round(0.5 * buildScore + 0.5 * modelScore);
    if (missingRoutes.length > 0) score = Math.min(score, 60);
    if (placeholderHits > 0) score = Math.min(score, 75);
    score = Math.max(0, Math.min(100, score));

    const blocking = issues.filter((i) => i.severity !== "minor").length;
    await input.emit(
      blocking > 0 ? "warn" : "success",
      `-> verify finished in ${Math.round((Date.now() - started) / 1000)}s · ${issues.length} issue(s), ${blocking} blocking · score ${score}/100`,
    );

    return { ok: true, usable: true, issues, score, built, tokens };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ————— helpers ————— */

async function run(cmd: string, args: string[], cwd: string, timeoutMs: number) {
  try {
    const { stdout, stderr } = await exec(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, output: `${stdout}\n${stderr}` };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: e.code ?? 1, output: `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}` };
  }
}

function excerpt(output: string): string {
  const lines = output.split("\n").filter((l) => l.trim().length > 0);
  const interesting = lines.filter((l) => /error|failed|cannot|not found|expected/i.test(l));
  return (interesting.length > 0 ? interesting : lines).slice(-14).join("\n").slice(0, 2_000);
}

/** Pull file paths out of a compiler's output so the fix round lands on them. */
function namedFiles(output: string): string[] {
  const hits = new Set<string>();
  for (const m of output.matchAll(/([\w./-]+\.(?:tsx?|jsx?|css|html|json))[\s:]/g)) {
    if (!m[1].includes("node_modules")) hits.add(m[1]);
    if (hits.size >= 5) break;
  }
  return [...hits];
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", ".next", "dist", "build", ".vercel", "coverage"]);
  async function walk(rel: string, depth: number): Promise<void> {
    if (depth > 8 || out.length > 2_000) return;
    const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (skip.has(e.name) || e.name.startsWith(".")) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path, depth + 1);
      else out.push(path);
    }
  }
  await walk("", 0);
  return out.sort();
}

function routeHasFile(files: string[], route: string): boolean {
  const clean = route.replace(/^\//, "").replace(/\/$/, "");
  if (!clean) return true;
  const stem = clean.replace(/-/g, "");
  return files.some((f) => {
    const p = f.toLowerCase();
    return (
      p === `${clean}.html` ||
      p === `${clean}/index.html` ||
      p === `app/${clean}/page.tsx` ||
      p === `app/${clean}/page.ts` ||
      p === `pages/${clean}.tsx` ||
      p === `pages/${clean}.tsx`.replace(/-/g, "") ||
      p === `app/${stem}/page.tsx` ||
      p === `src/app/${clean}/page.tsx` ||
      p === `src/pages/${clean}.tsx`
    );
  });
}

function routeGuess(route: string): string {
  const clean = route.replace(/^\//, "");
  return `app/${clean}/page.tsx`;
}

async function keyFileContents(dir: string): Promise<string> {
  const chunks: string[] = [];
  for (const f of KEY_FILES) {
    const text = await readFileSafe(join(dir, f));
    if (text) chunks.push(`--- ${f} ---\n${text.slice(0, KEY_FILE_BYTES)}`);
  }
  return chunks.join("\n\n") || "(none)";
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    if (s.size > 200_000) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
