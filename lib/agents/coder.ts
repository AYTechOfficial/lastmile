/* The Coding Agent.

   Turns the master build prompt into a real codebase, in a real repository, with
   a real commit. This is the stage the whole product exists to reach, and it is
   built around one rule that keeps it honest:

       The model writes the product. The harness guarantees it builds.

   That split is deliberate and it is what makes the output trustworthy. The
   scaffold — package.json, the TypeScript config, the Tailwind wiring, the root
   layout — is generated deterministically by this file, never by a model, so a
   run cannot produce a codebase that fails to install because a model invented a
   dependency version. The model's job is the part that actually needs judgement:
   the screens, the components, and the data handling that make this specific
   product what it is.

   Two modes, because the pipeline has two shapes:

     · firstPass — the full build, from the master prompt.
     · fixOnly   — a surgical re-patch, scoped to the files the defect ledger
                   named. A small defect must not rewrite a working codebase,
                   which is why the Verifier records file paths with each issue.

   And it degrades rather than dying, like every other agent here. If no model
   answers, it ships the scaffold with the flows rendered as real, working
   screens derived from the spec — plain, but a product that runs and can be
   verified — and says so in the run log. A run that stops at "the coding agent
   is unavailable" would throw away everything research and the checkpoint
   produced. */

import type { MasterBuildPrompt, ProductSpec } from "../domain";
import { chatJson, defaultModelFor, type ChatInput } from "../ai/chat";
import { commitFiles, ensureRepo, getRepoFile, latestSha } from "../platform/github";
import type { PlanConfig } from "../plans";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type CodeInput = {
  sentence: string;
  slug: string;
  plan: PlanConfig;
  userId: string | null;
  preferredModel?: string | null;
  /** the contract the code will be verified against */
  master: MasterBuildPrompt | null;
  spec: ProductSpec | null;
  /** the repo to commit to, when one already exists */
  repo: { owner: string; name: string } | null;
  /** true for the first build; a fix round is scoped and additive */
  firstPass: boolean;
  /** files a fix round should touch, from the defect ledger */
  files?: string[];
  /** the deployed platform's own build error, when the deploy stage bounced
      the run back — the most precise failure report the pipeline has */
  deployError?: string | null;
  /** the open defect ledger (severity, title, files, diagnostics), carried from
      the runner when it enqueued this fix round */
  issuesText?: string | null;
  /** a human's continue request on a finished product — the headline
      instruction for this round, above any defect ledger */
  continueRequest?: string | null;
  iteration: number;
  emit: (kind: "info" | "command" | "success" | "warn" | "error" | "url", line: string) => Promise<void>;
  heartbeat: () => Promise<void>;
};

export type CodeResult = {
  ok: boolean;
  repo: { owner: string; name: string; url: string } | null;
  commitSha: string | null;
  files: string[];
  tokens: number;
  /** true when the code came from the model, false when it is the fallback */
  generated: boolean;
  /** true only when the self-check saw the merged project build clean, so a
      caller can treat "this round landed" as "the defects are actually gone" */
  buildClean: boolean;
  reason?: string;
};

export async function runCoder(input: CodeInput): Promise<CodeResult> {
  const started = Date.now();
  const { slug } = input;

  await input.emit(
    "command",
    input.firstPass ? `$ lastmile code --build ${slug}` : `$ lastmile code --fix iteration ${input.iteration}`,
  );

  /* ————— 1. the repository ————— */

  const owner = input.repo?.owner ?? (await repoOwner());
  const name = input.repo?.name ?? slug;

  if (!owner) {
    return {
      ok: false,
      repo: null,
      commitSha: null,
      files: [],
      tokens: 0,
      generated: false,
      buildClean: false,
      reason: "no GitHub account is configured, so there is nowhere to commit the generated code",
    };
  }

  let repoUrl = input.repo ? `https://github.com/${owner}/${name}` : null;

  if (!input.repo) {
    await input.emit("info", `creating repository ${owner}/${name}`);
    const created = await ensureRepo(owner, name, false);
    if (!created.ok) {
      return {
        ok: false,
        repo: null,
        commitSha: null,
        files: [],
        tokens: 0,
        generated: false,
        buildClean: false,
        reason: created.detail ?? `could not create ${owner}/${name}`,
      };
    }
    repoUrl = created.repoUrl;
    await input.emit("success", created.created ? `repository created — ${repoUrl}` : `repository exists — adopting ${repoUrl}`);
  } else {
    await input.emit("info", `committing to ${owner}/${name}`);
  }

  await input.heartbeat();

  /* ————— 2. the code ————— */

  /* The main coder acts as an orchestrator on the first pass: it splits the
     product into work packages and spawns WORKER agents — same chain, smaller
     scope — that write their file groups in parallel. Each worker returns
     finished files; the main coder merges them into one codebase. Fewer tokens
     per request, more parallelism, and one bad worker cannot erase the others. */
  const generated = input.firstPass ? await fanOutWorkers(input) : await askModel(input);
  let files = generated.files;
  let tokens = generated.tokens;
  let reason = generated.reason;

  if (input.firstPass && generated.workers) {
    await input.emit(
      "info",
      `workers: ${generated.workers.spawned} spawned · ${generated.workers.delivered} delivered ${generated.workers.files} file(s) in parallel`,
    );
  }

  /* The scaffold is always merged in, and always wins on the files it owns.
     That is the guarantee: whatever the model returns, the result has a valid
     package.json and a valid layout, so it installs and builds. */
  files = mergeScaffold(files, input);

  if (!generated.ok) {
    await input.emit(
      "warn",
      `no model answered (${reason ?? "chain exhausted"}) — shipping the scaffold with screens derived from the spec`,
    );
    reason = reason ?? "the code was generated without a model";
  } else {
    await input.emit("success", `model wrote ${generated.files.length} file(s) in ${Math.round(generated.ms / 1000)}s`);
  }

  /* A fix round must never delete the app: it replaces the files it was scoped
     to, and the scaffold keeps the rest of the project coherent. */
  if (!input.firstPass) {
    const scoped = new Set(input.files ?? []);
    if (scoped.size > 0) {
      const before = files.length;
      files = files.filter((f) => !isScaffold(f.path));
      await input.emit(
        "info",
        `fix round scoped to ${scoped.size} file(s); ${before - files.length} scaffold file(s) preserved`,
      );
    }
  }

  await input.heartbeat();

  /* ————— 3. the harness's own guarantee ————— */

  /* What the repo holds right now, and what this commit changes. Both matter.
     The self-check has to build the project as it will exist after the commit —
     the untouched files included, or a fix round is checked against a project
     that lacks its own package.json. And a first build into an existing repo
     has to drop the files the previous product left behind: commits are
     additive, so a new spec silently inherited the old product's routes, and
     the verifier reported them as dead pages. */
  const repoFiles = await loadRepoFiles(owner, name);
  const writes = new Set(files.map((f) => f.path));
  const stale = input.firstPass
    ? [...repoFiles.keys()].filter((p) => !writes.has(p) && !KEEP_FILE.test(p))
    : [];
  if (stale.length > 0) {
    await input.emit(
      "info",
      `-> dropping ${stale.length} stale file(s) the previous build left behind (${stale.slice(0, 4).join(", ")}${stale.length > 4 ? ", …" : ""})`,
    );
  }

  const project = new Map(repoFiles);
  for (const file of files) project.set(file.path, file.content);
  for (const path of stale) project.delete(path);
  const projectFiles = [...project.entries()].map(([path, content]) => ({ path, content }));

  /* The header promises that the model writes the product and the harness
     guarantees it builds. This is where that promise is kept: the project as it
     will exist after the commit is installed and built for real, and the
     build's own output drives repair rounds when it fails. */
  const gate = await compileGate(input, files, projectFiles);
  files = gate.files;
  tokens += gate.tokens;
  const buildClean = gate.cleared;

  await input.heartbeat();

  /* ————— 4. commit ————— */

  const commit = await commitFiles({
    owner,
    name,
    files: files.map((f) => ({ path: f.path, content: f.content })),
    ...(stale.length > 0 ? { remove: stale } : {}),
    message: input.firstPass
      ? `Build ${input.master?.productName ?? input.sentence}\n\nGenerated by LastMile from the master build prompt.\n${input.master?.tagline ?? ""}`.trim()
      : `Fix iteration ${input.iteration}\n\nScoped re-patch from the defect ledger.\n${(input.files ?? []).join(", ")}`.trim(),
  });

  if (!commit.ok) {
    return {
      ok: false,
      repo: repoUrl ? { owner, name, url: repoUrl } : null,
      commitSha: null,
      files: files.map((f) => f.path),
      tokens,
      generated: generated.ok,
      buildClean,
      reason: commit.detail ?? "the commit failed",
    };
  }

  await input.emit("success", `committed ${files.length} file(s) — ${commit.sha?.slice(0, 7)}`);
  await input.emit("url", `${repoUrl}/commit/${commit.sha}`);
  await input.emit("info", `code stage finished in ${Math.round((Date.now() - started) / 1000)}s`);

  return {
    ok: true,
    repo: repoUrl ? { owner, name, url: repoUrl } : null,
    commitSha: commit.sha,
    files: files.map((f) => f.path),
    tokens,
    generated: generated.ok,
    buildClean,
    reason: generated.ok ? undefined : reason,
  };
}

/** The repo's current files, by path. Fetched one path at a time through the
    same helper the fix context uses, so the token never reaches a command line,
    and a repo that does not exist yet simply reads as empty. */
async function loadRepoFiles(owner: string, name: string): Promise<Map<string, string>> {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) return new Map();
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${name}/git/trees/main?recursive=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "lastmile" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return new Map();
    const body = (await res.json()) as { tree?: { path?: string; type?: string }[] };
    const out = new Map<string, string>();
    for (const entry of (body.tree ?? []).slice(0, 120)) {
      if (entry.type !== "blob" || !entry.path) continue;
      const content = await getRepoFile(owner, name, entry.path);
      if (content !== null) out.set(entry.path, content);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Files a rebuild never deletes: the repo's own front matter, not the product. */
const KEEP_FILE = /^(README\.md|LICENSE|LICENCE|\.gitattributes|\.gitignore)$/i;

/** Who owns the generated repo. The platform token's own account, so a repo is
    always created somewhere the token can actually write. */
async function repoOwner(): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) return null;
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "lastmile", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { login?: string };
    return body.login ?? null;
  } catch {
    return null;
  }
}

/* ————————————————————————— the model's part ————————————————————————— */

type GeneratedFile = { path: string; content: string };

/* ————————————————————————— the worker fan-out ————————————————————————— */

/** How the first pass is split into worker packages. Deterministic from the
    spec, so a re-run splits the same way: the main page and one package per
    extra route, plus a components package when the product is wide enough to
    have reusable parts. Capped so a huge spec cannot spawn a swarm. */
function workPackages(input: CodeInput): { label: string; files: string[]; brief: string }[] {
  const spec = input.spec;
  const routes = (spec?.routes ?? [{ path: "/", purpose: "the main screen" }]).slice(0, 5);
  const packages: { label: string; files: string[]; brief: string }[] = [];

  const main = routes[0];
  packages.push({
    label: "main screen",
    files: ["app/page.tsx"],
    brief: `The product's main screen at ${main.path} — ${main.purpose}. This is the heart of the product; make it complete, polished and real.`,
  });

  for (const r of routes.slice(1)) {
    const clean = r.path.replace(/^\//, "").replace(/[^\w-]/g, "-");
    packages.push({
      label: `route ${r.path}`,
      files: [`app/${clean}/page.tsx`],
      brief: `The ${r.purpose} screen at ${r.path}. It must work with the main screen's data model and feel like the same product.`,
    });
  }

  const flowCount = spec?.flows.length ?? 0;
  if (flowCount >= 3) {
    /* No "shared components" package: components/ui.tsx is harness-owned and
       already exists. A worker that wrote it would have to guess the API the
       other workers are guessing at, and the guess only fails in type check. */
    packages.push({
      label: "shared widgets",
      files: ["components/widgets.tsx"],
      brief: `Product-specific pieces this app needs beyond the shared kit ("@/components/ui") — score panels, board cells, anything reused across screens. Never redefine Button, Card, Badge, EmptyState or ListRow; those exist and are imported from the kit.`,
    });
  }

  return packages.slice(0, 5);
}

/** Spawn the workers and wait for all of them. Each worker is a full chat call
    over the same failover chain with a NARROW brief: it writes only its own
    files, in full, and returns them. One worker failing costs its files only —
    the main coder's merge and the fallback page keep the project buildable. */
async function fanOutWorkers(
  input: CodeInput,
): Promise<{ ok: boolean; files: GeneratedFile[]; tokens: number; ms: number; reason?: string; workers?: { spawned: number; delivered: number; files: number } }> {
  const started = Date.now();
  const packages = workPackages(input);

  if (packages.length <= 1) {
    /* Nothing to split — one screen is one worker's job anyway. */
    const single = await askModel(input);
    return { ...single, workers: { spawned: 1, delivered: single.ok ? 1 : 0, files: single.files.length } };
  }

  await input.emit(
    "info",
    `-> splitting the build into ${packages.length} worker agent(s): ${packages.map((p) => p.label).join(", ")}`,
  );

  const results = await Promise.all(
    packages.map(async (pkg) => {
      const chatInput: ChatInput = {
        tier: input.plan.modelTier,
        userId: input.userId,
        agent: "code",
        preferred: input.preferredModel ?? defaultModelFor(input.plan.modelTier),
        timeoutMs: 240_000,
        maxRungs: 10,
        onAttempt: async (attempt) => {
          if (!attempt.ok) {
            await input.emit("warn", `  worker [${pkg.label}] rung failed: ${attempt.detail ?? "unknown"}`);
          }
        },
      };

      const { value, result, parseError } = await chatJson<{ files?: GeneratedFile[] }>(chatInput, [
        {
          role: "system",
          content:
            "You are a worker coding agent. You build ONE part of a larger Next.js product, exactly to your brief. You write complete, working code — no placeholders, no TODOs. You return ONLY files in your own scope. Think briefly, then answer — your reply budget is finite and the code matters more than deliberation.",
        },
        { role: "user", content: workerPrompt(input, pkg) },
      ]);

      const files = sanitize(value?.files ?? []);
      return { label: pkg.label, ok: result.ok && files.length > 0, files, tokens: result.tokens, reason: result.reason ?? parseError };
    }),
  );

  const delivered = results.filter((r) => r.ok);
  const files = delivered.flatMap((r) => r.files);
  const tokens = results.reduce((n, r) => n + r.tokens, 0);

  for (const r of results) {
    await input.emit(
      r.ok ? "success" : "warn",
      r.ok ? `  worker [${r.label}] finished — ${r.files.length} file(s)` : `  worker [${r.label}] failed (${r.reason ?? "no usable files"})`,
    );
  }
  await input.heartbeat();

  if (files.length === 0) {
    /* Every worker failed — fall through to the single-shot path so the stage
       still produces something buildable. */
    const single = await askModel(input);
    return { ...single, tokens: tokens + single.tokens, ms: Date.now() - started, workers: { spawned: packages.length, delivered: 0, files: 0 } };
  }

  return {
    ok: true,
    files,
    tokens,
    ms: Date.now() - started,
    workers: { spawned: packages.length, delivered: delivered.length, files: files.length },
  };
}

/** The worker's brief: the same contract the main coder works to, narrowed to
    the package's files, with the interfaces it must fit (data model, design
    tokens, the localStorage keys) so separately-written files still compile
    together. */
function workerPrompt(input: CodeInput, pkg: { label: string; files: string[]; brief: string }): string {
  const master = input.master;
  const spec = input.spec;
  const table = spec?.dataModel[0] ?? { table: "items", columns: ["id", "title", "created_at"] };
  const key = `lastmile:${input.slug}:${table.table}`;

  return `You are building ONE part of "${master?.productName ?? input.sentence}". Write ONLY these files:
${pkg.files.map((f) => `- ${f}`).join("\n")}

YOUR BRIEF
${pkg.brief}

Reply with ONLY a JSON object of the shape:
{ "files": [ { "path": "${pkg.files[0]}", "content": "..." } ] }

STRICT RULES
- Next.js App Router, TypeScript, client components ("use client") where the file renders UI.
- Tailwind utility classes only.
- Persistence: through the harness helper "@/lib/persist" — readLocal<T>(key, fallback) and writeLocal(key, value). Never call localStorage directly: these screens are prerendered on the server, where localStorage does not exist, and a direct read during render is a build failure. Key exactly "${key}" — the other screens read the same key, so the product works as one.
- Shared record type (match this exactly): type RecordItem = { id: string; title: string; notes: string; createdAt: string }. Never declare a type named Record — that name belongs to TypeScript's own utility type and redeclaring it breaks every file that uses it.
- The shared kit already exists at "@/components/ui" — harness-owned, so you may import from it but never rewrite it. Its exact API:
    Button({ variant?: "primary" | "secondary" | "danger" | "outline" | "ghost" | "link", size?: "sm" | "md" | "lg", ...buttonProps })
    Card({ className?, ...divProps })
    Badge({ tone?: "brand" | "pass" | "warn" | "bad" | "neutral" })
    EmptyState({ title?, message?, description?, icon?, action?, className? })
    ListRow({ record?, title?, subtitle?, trailing?, className? })
  Call them with exactly these props — any other prop name is a TypeScript error and fails the build.
- Shared types are contracts: declare each one in ONE file and import it everywhere else. Never declare a type whose name another module already exports — two same-named declarations with different shapes are accepted file by file and rejected when the files are merged, and the compiler prints both as the same name.
- Any other shared piece goes in "components/widgets.tsx" (your file) and must not re-export or shadow the kit's names.
- Write REAL content for this specific product. No lorem ipsum, no placeholders, no TODOs.
- Every overlay, modal, panel and section you render must be REACHABLE in some state. Never gate one on a value the same update clears away — a queue timer that sets phase: "playing" turns a match modal rendered only when phase === "queue" into dead code — and never ship a section with a hardcoded "hidden" class. Before you finish, walk every screen's states and check each condition can actually become true.
- Do not create any file not listed above.
- Escape all newlines inside "content" correctly so the JSON parses.

DESIGN SYSTEM (use these exact values)
${master ? `look: ${master.design.look}\nbackground: ${master.design.colors.background}\nsurface: ${master.design.colors.surface}\nprimary: ${master.design.colors.primary}\naccent: ${master.design.colors.accent}\nfont: ${master.design.font}` : "dark, dense, engineering-tool aesthetic; accent #4f8cff"}

FLOWS THIS SCREEN MUST SERVE
${(spec?.flows ?? []).map((f) => `- ${f.name}: ${f.criteria.join("; ")}`).join("\n") || "- the main flow works end to end"}

EDGE CASES THAT MUST NOT BREAK
${(master?.edgeCases ?? ["empty lists show a next step", "long text does not break layout"]).map((e) => `- ${e}`).join("\n")}`;
}

async function askModel(
  input: CodeInput,
): Promise<{ ok: boolean; files: GeneratedFile[]; tokens: number; ms: number; reason?: string; workers?: undefined }> {
  const started = Date.now();
  const chatInput: ChatInput = {
    tier: input.plan.modelTier,
    userId: input.userId,
    agent: "code",
    preferred: input.preferredModel ?? defaultModelFor(input.plan.modelTier),
    /* Code generation is the longest call in the pipeline by a wide margin. */
    timeoutMs: 240_000,
    maxRungs: 10,
    onAttempt: async (attempt) => {
      await input.emit(
        attempt.ok ? "success" : "warn",
        `  model ${attempt.provider}/${attempt.model} ${attempt.ok ? "answered" : `failed (${attempt.detail ?? "unknown"})`} in ${Math.round(attempt.ms / 1000)}s`,
      );
    },
  };

  if (!input.firstPass) {
    /* Fix rounds are coded IN PASSES: the named files are grouped two per
       call, and each call sees only its own files' contents. Reasoning models
       size their thinking to the prompt — a small ask gets a full answer in
       seconds, a huge one burns the whole output budget and returns nothing —
       so the pass count is bounded, not the prompt size. One pass failing
       costs one pass; the others still land. */
    const grouped = await fixInPasses(input, chatInput);
    return {
      ok: grouped.files.length > 0,
      files: grouped.files,
      tokens: grouped.tokens,
      ms: Date.now() - started,
      reason: grouped.files.length === 0 ? grouped.reason ?? "every fix pass failed" : undefined,
    };
  }

  const prompt = buildPrompt(input);
  const { value, result, parseError } = await chatJson<{ files?: GeneratedFile[] }>(chatInput, [
    {
      role: "system",
      content:
        "You are a senior front-end engineer. You write complete, working Next.js App Router code. You never write placeholders, TODOs, or comments explaining what code should do — you write the code. Think briefly, then answer — your reply budget is finite and the code matters more than deliberation.",
    },
    { role: "user", content: prompt },
  ]);

  if (!result.ok || !value) {
    return { ok: false, files: [], tokens: result.tokens, ms: Date.now() - started, reason: result.reason ?? parseError ?? "the model returned no code" };
  }

  const files = sanitize(value.files ?? []);
  if (files.length === 0) {
    return { ok: false, files: [], tokens: result.tokens, ms: Date.now() - started, reason: "the model returned no usable files" };
  }

  return { ok: true, files, tokens: result.tokens, ms: Date.now() - started };
}

/* ————————————————————————— fix passes ————————————————————————— */

const PASS_MAX_FILES = 2;

/* A pass is only worthwhile when the model can see what it is fixing, so the
   context of each pass is strictly bounded: its own files' current contents
   (truncated per file), and the shared kit only when one of the pass's files
   imports from it. */
async function fixInPasses(
  input: CodeInput,
  chatInput: ChatInput,
): Promise<{ files: GeneratedFile[]; tokens: number; reason?: string }> {
  const context = await loadFixContext(input);
  if (context.files.length === 0 && !(input.continueRequest || input.issuesText)) {
    return { files: [], tokens: 0, reason: "nothing to fix was named and the repo has no matching files" };
  }

  const allNamed = [...new Set([...(input.files ?? []), ...context.files.map((f) => f.path)])];
  const passes: string[][] = [];
  let current: string[] = [];
  for (const path of allNamed.slice(0, 10)) {
    current.push(path);
    if (current.length >= PASS_MAX_FILES) {
      passes.push(current);
      current = [];
    }
  }
  if (current.length > 0) passes.push(current);
  if (passes.length === 0 && (input.continueRequest || input.issuesText)) passes.push([]);

  const emitted: GeneratedFile[] = [];
  let tokens = 0;
  let passFailures = 0;
  for (let i = 0; i < passes.length; i += 1) {
    const passFiles = passes[i];
    const scoped = context.files.filter((f) => passFiles.length === 0 || passFiles.includes(f.path));
    const effective: string[] = scoped.length > 0 ? scoped.map((f) => f.path) : passFiles;
    const passContext = scoped.length > 0 || passFiles.length === 0 ? { files: scoped, kit: context.kit } : { files: [], kit: null };
    const prompt = fixPrompt({ ...input, files: effective }, passContext);

    await input.emit("info", `-> fix pass ${i + 1}/${passes.length}: ${effective.length > 0 ? effective.join(", ") : "(continue request)"}`);

    const { value, result } = await chatJson<{ files?: GeneratedFile[] }>(chatInput, [
      {
        role: "system",
        content:
          "You are a senior front-end engineer. You write complete, working Next.js App Router code. You never write placeholders, TODOs, or comments explaining what code should do — you write the code. Think briefly, then answer — your reply budget is finite and the code matters more than deliberation.",
      },
      { role: "user", content: prompt },
    ]);

    if (result.attempts.length > 0) {
      for (const a of result.attempts.slice(-1)) {
        await input.emit(
          a.ok ? "success" : "warn",
          `  pass ${i + 1}: model ${a.provider}/${a.model} ${a.ok ? "answered" : `failed (${a.detail ?? "unknown"})`} in ${Math.round(a.ms / 1000)}s`,
        );
      }
    }

    if (!result.ok || !value) {
      passFailures += 1;
      continue;
    }
    const files = sanitize(value.files ?? []);
    if (files.length === 0) {
      await input.emit("warn", `  pass ${i + 1}: no usable files — moving to the next pass`);
      passFailures += 1;
      continue;
    }
    tokens += result.tokens;
    for (const f of files) emitted.push(f);
  }
  return {
    files: emitted,
    tokens,
    reason: passFailures === passes.length ? "no pass produced usable files" : undefined,
  };
}

function buildPrompt(input: CodeInput): string {
  const master = input.master;
  const spec = input.spec;

  return `Build the complete product described below. Reply with ONLY a JSON object of the shape:
{ "files": [ { "path": "app/page.tsx", "content": "..." } ] }

STRICT RULES
- Next.js App Router with TypeScript. Every page is a client component ("use client").
- Styling: Tailwind utility classes only. No CSS modules, no styled-components.
- Persistence: localStorage only, reached through the harness helper "@/lib/persist" (readLocal<T>(key, fallback) / writeLocal(key, value)). There is no backend and no database. Never call localStorage directly — every screen is prerendered on the server, where localStorage does not exist, and a direct read during render is a build failure.
- Write REAL content for this specific product. No lorem ipsum, no placeholders, no TODOs.
- Every overlay, modal, panel and section you render must be REACHABLE in some state. Never gate one on a value the same update clears away — a queue timer that sets phase: "playing" turns a match modal rendered only when phase === "queue" into dead code — and never ship a section with a hardcoded "hidden" class. Before you finish, walk every screen's states and check each condition can actually become true.
- EVERY file must be COMPLETE from its first line to its last. A file that ends mid-function, mid-object or mid-JSX is a failed build. If you are running short on space, simplify styling and commentary — never stop before the file is finished and syntactically whole.
- Do not create: package.json, tsconfig.json, next.config.mjs, postcss.config.mjs, app/layout.tsx, app/globals.css, components/ui.tsx, lib/persist.ts. Those already exist and are correct — any file you return with those paths is discarded.
- Files you SHOULD write: app/page.tsx plus any routes in the spec, and components/ files for the parts that are reused.
- The shared kit already exists at components/ui.tsx — import from "@/components/ui", never rewrite it. Its exact API:
    Button({ variant?: "primary" | "secondary" | "danger" | "outline" | "ghost" | "link", size?: "sm" | "md" | "lg", ...buttonProps })
    Card({ className?, ...divProps })
    Badge({ tone?: "brand" | "pass" | "warn" | "bad" | "neutral" })
    EmptyState({ title?, message?, description?, icon?, action?, className? })
    ListRow({ record?, title?, subtitle?, trailing?, className? })
  Calling them with any other prop name is a TypeScript error and fails the build.
- Shared types are contracts: declare each one in ONE file and import it everywhere else. Never declare a type whose name another module already exports — two same-named declarations with different shapes are accepted file by file and rejected when the files are merged, and the compiler prints both as the same name.
- Escape all newlines inside "content" correctly so the JSON parses.

MASTER BUILD PROMPT
${master?.instructions ?? `Build: ${input.sentence}`}

DESIGN SYSTEM (use these exact values)
${master ? `look: ${master.design.look}\nbackground: ${master.design.colors.background}\nsurface: ${master.design.colors.surface}\nprimary: ${master.design.colors.primary}\naccent: ${master.design.colors.accent}\nfont: ${master.design.font}` : "dark, dense, engineering-tool aesthetic; accent #4f8cff"}

ROUTES
${(spec?.routes ?? [{ path: "/", purpose: "the main screen" }]).map((r) => `- ${r.path} — ${r.purpose}`).join("\n")}

FLOWS THAT MUST WORK
${(spec?.flows ?? []).map((f) => `- ${f.name}: ${f.criteria.join("; ")}`).join("\n")}

DATA MODEL (persist to localStorage)
${(spec?.dataModel ?? [{ table: "items", columns: ["id", "title", "created_at"] }]).map((t) => `- ${t.table}: ${t.columns.join(", ")}`).join("\n")}

EDGE CASES THAT MUST NOT BREAK
${(master?.edgeCases ?? ["empty lists show a next step", "long text does not break layout"]).map((e) => `- ${e}`).join("\n")}

QUALITY BAR
${(master?.qualityBar ?? []).map((q) => `- ${q}`).join("\n")}`;
}

/** What a fix round has to see to stop guessing: the files it may change as
    they exist in the repo right now, plus the shared kit they compile against.

    The old prompt named the file paths and nothing else, so the fixer
    regenerated page.tsx from memory of the master prompt — keeping some of it,
    losing the rest, and turning one compile error into a different one. Round
    after round, until the budget ran out. */
async function loadFixContext(input: CodeInput): Promise<{
  files: { path: string; content: string }[];
  kit: string | null;
}> {
  if (!input.repo) return { files: [], kit: null };
  const { owner, name } = input.repo;
  const files: { path: string; content: string }[] = [];
  const seen = new Set<string>();
  /* Deliberately tight. Reasoning models (GLM, DeepSeek) size their thinking to
     the prompt: at a 79-token input one answered fully in 8s; at 4k+ tokens the
     same model burned its whole output budget thinking and returned empty
     content — the "empty message" failure that used to cost whole fix rounds.
     ~24k characters (~6k tokens) of context keeps the chain's reasoning models
     inside the range where they actually answer. */
  let budget = 24_000;

  for (const path of (input.files ?? []).slice(0, 6)) {
    const content = await getRepoFile(owner, name, path);
    if (!content) continue;
    const clipped = content.slice(0, 8_000);
    if (clipped.length > budget) break;
    budget -= clipped.length;
    seen.add(path);
    files.push({ path, content: clipped });
  }

  /* And the modules those files import. A defect in a screen is often really a
     mismatch with a type another module owns — a store that declares
     `winner: string` while the screen declares `winner: Player | null`. The
     fixer that cannot see the other side of that contract invents a cast
     instead of a fix, and the next build fails the same way. */
  const companions: string[] = [];
  for (const file of files) {
    for (const match of file.content.matchAll(/from\s+["'](@\/[^"']+)["']/g)) {
      const base = match[1].slice(2);
      for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
        if (!seen.has(candidate) && !companions.includes(candidate)) companions.push(candidate);
      }
    }
  }

  for (const candidate of companions.slice(0, 5)) {
    if (budget <= 0) break;
    const content = await getRepoFile(owner, name, candidate);
    if (!content) continue;
    const clipped = content.slice(0, 4_000);
    if (clipped.length > budget) break;
    budget -= clipped.length;
    seen.add(candidate);
    files.push({ path: candidate, content: clipped });
  }

  const kit = await getRepoFile(owner, name, "components/ui.tsx");
  return { files, kit: kit ? kit.slice(0, 6_000) : null };
}

function fixPrompt(
  input: CodeInput,
  context: { files: { path: string; content: string }[]; kit: string | null },
): string {
  const contents = context.files
    .map(
      (f) =>
        `--- ${f.path} (current contents — preserve everything that is not defective) ---\n\n${f.content}`,
    )
    .join("\n\n");

  const continueAsk = input.continueRequest
    ? `\nTHE HUMAN'S CONTINUE REQUEST (the headline for this round — build it to the same visual and quality bar as the rest of the product: AAA, polished, brand-consistent. Update the spec's routes/flows where the request adds them.):\n${input.continueRequest}\n`
    : "";

  return `${input.continueRequest ? "Update an existing Next.js product per the human's continue request." : "Fix defects in an existing Next.js product."} Reply with ONLY:
{ "files": [ { "path": "...", "content": "<the complete corrected file>" } ] }

Return the COMPLETE corrected contents of only the files that need changing — not a diff, not a fragment.
A file that ends mid-function, mid-object or mid-JSX is a failed build — if space is tight, simplify styling, never cut logic.
Do not create package.json, tsconfig.json, next.config.mjs, postcss.config.mjs, app/layout.tsx, app/globals.css, components/ui.tsx or lib/persist.ts.
Keep everything that already works; change only what the defects require — UNLESS a continue request below says otherwise: then build the request fully, adding whatever files and routes it needs.
When a screen is unreachable, fix the state transition that makes it unreachable — never delete the screen, and never leave it gated on the state the same update replaces.
When the defect is a type mismatch, fix the type — never cast around it with "as X", and if the type belongs to another module, import it from there instead of declaring a second type with that name.
${continueAsk}${input.issuesText ? `
OPEN DEFECTS (the verifier's ledger — severity, the exact diagnostics, the files it names)
${input.issuesText}
` : ""}${input.deployError ? `
DEPLOY FAILURE (the hosting platform rejected the build — fix what it names)
${input.deployError.slice(0, 2000)}
` : ""}
FILES THE DEFECTS POINT AT
${(input.files ?? []).join("\n") || "(the defects did not name files — find them yourself)"}
${contents ? `
CURRENT CONTENTS OF THOSE FILES, AND OF THE MODULES THEY IMPORT (authoritative)
A defect is often a contract between two files, not a mistake inside one. If a type is declared in one of these files, import it — never declare a second type with the same name, and never cast around a mismatch with "as X".

${contents}
` : ""}${context.kit ? `
SHARED KIT (reference — harness-owned, import from "@/components/ui", never rewrite)
${context.kit}
` : `
SHARED KIT API (components/ui.tsx is harness-owned — import it, never rewrite it)
Button({ variant?: "primary" | "secondary" | "danger" | "outline" | "ghost" | "link", size?: "sm" | "md" | "lg" })
Card({ className? })
Badge({ tone?: "brand" | "pass" | "warn" | "bad" | "neutral" })
EmptyState({ title?, message?, description?, icon?, action?, className? })
ListRow({ record?, title?, subtitle?, trailing?, className? })
`}
STORAGE ("@/lib/persist" is harness-owned — import it, never rewrite it, never touch localStorage directly)
readLocal<T>(key: string, fallback: T): T   — returns the fallback on the server, where localStorage does not exist
writeLocal(key: string, value: unknown): void
MASTER BUILD PROMPT (the contract the code is held to — trimmed; the defect ledger above and the file contents are the authoritative detail for this round)
${(input.master?.instructions ?? input.sentence).slice(0, 6_000)}${(input.master?.instructions ?? "").length > 6_000 ? "\n… (trimmed — fix exactly what the ledger names, not the whole spec)" : ""}`;
}

/* ————————————————————————— validation ————————————————————————— */

const ALLOWED_EXT = /\.(tsx|ts|jsx|js|css|json|md)$/i;
const FORBIDDEN = /(^|\/)(package\.json|package-lock\.json|tsconfig\.json|next\.config\.[a-z]+|postcss\.config\.[a-z]+|app\/layout\.tsx|app\/globals\.css|components\/ui\.tsx|lib\/persist\.ts)$/i;

/** Keep only files this agent is allowed to write. A model that returns a
    package.json would otherwise overwrite the scaffold and break the build —
    the single most damaging thing it could do. */
function sanitize(files: GeneratedFile[]): GeneratedFile[] {
  const out: GeneratedFile[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") continue;

    /* Normalise, then reject anything that escapes the repo root. A path is
       attacker-controlled only in the sense that a model produced it, but the
       consequence of `../../` is a write outside the workspace, so it is
       checked rather than trusted. */
    const path = file.path.replace(/^\.?\//, "").replace(/\\/g, "/").trim();
    if (!path || path.includes("..") || path.startsWith("/")) continue;
    if (!ALLOWED_EXT.test(path)) continue;
    if (FORBIDDEN.test(path)) continue;
    if (seen.has(path)) continue;

    /* A file with no content is worse than no file: it would delete working
       code on a fix round. */
    if (file.content.trim().length < 20) continue;

    seen.add(path);
    out.push({ path, content: file.content });
  }

  /* A codebase without a page is not a product. */
  return out.slice(0, 60);
}

function isScaffold(path: string): boolean {
  return FORBIDDEN.test(path);
}

/* ————————————————————————— the compile gate ————————————————————————— */

/* One failure mode kept costing whole runs, and it always looked the same: two
   workers declare a type with the same name and different shapes — the store
   says `winner: string`, the screen says `winner: Player | null` — or a fix
   round patches one file and breaks the contract another file owns. Each file
   compiles alone, so nothing notices until a later build, and the fixer that
   gets the error cannot see the other side of the contract, so it casts around
   the mismatch instead of fixing it and the next build fails the same way.

   The answer is not a smarter prompt, it is the compiler: materialise the
   merged project, install it, run the real `tsc` over it, and when it rejects
   the code, hand the compiler's own output back to the model and try again.
   Nothing reaches the commit blind. If the error survives its repairs, it is
   reported honestly and the verifier sees the real state. */

const SELF_CHECK_REPAIRS = 2;
const INSTALL_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 300_000;
const MAX_REPORTED_ERRORS = 6_000;

type CommandResult = { code: number; out: string };

/** Run a command and resolve with its exit code and combined output. It never
    rejects — a failing compiler is data here, not an exception.

    `shell` is opt-in because it concatenates the command line: a shell is
    needed to launch npm's .cmd shim on Windows (Node refuses it otherwise),
    but it must never wrap the Node binary, whose own path can contain spaces
    when it lives under "C:\Program Files". Every argument here is a constant. */
function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  shell = false,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell },
      (error, stdout, stderr) => {
        const out = `${stdout ?? ""}${stderr ?? ""}`;
        if (!error) return resolve({ code: 0, out });
        const code = typeof error.code === "number" ? error.code : 1;
        resolve({ code, out: out || error.message });
      },
    );
  });
}

async function writeProject(dir: string, files: GeneratedFile[]): Promise<void> {
  for (const file of files) {
    const target = path.join(dir, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

/** The first line worth showing: the compiler's diagnostic when there is one,
    otherwise the build's own complaint. A wall of output is noise in a run log. */
function firstErrorLine(errors: string): string {
  const lines = errors.split("\n").map((l) => l.trim()).filter(Boolean);
  const line =
    lines.find((l) => /error TS\d+/.test(l)) ??
    lines.find((l) => /error:/i.test(l)) ??
    lines.find((l) => /error|failed/i.test(l)) ??
    lines[0] ??
    "";
  return line.slice(0, 300);
}

/** The repair's files replace their paths in the project; nothing else moves. */
function mergeRepairs(files: GeneratedFile[], repairs: GeneratedFile[]): GeneratedFile[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const repair of repairs) {
    if (isScaffold(repair.path)) continue;
    byPath.set(repair.path, repair);
  }
  return [...byPath.values()];
}

export async function compileGate(
  input: CodeInput,
  changed: GeneratedFile[],
  project: GeneratedFile[],
): Promise<{ files: GeneratedFile[]; tokens: number; cleared: boolean }> {
  let tokens = 0;
  let currentProject = project;
  const started = Date.now();
  const dir = await mkdtemp(path.join(tmpdir(), "lastmile-check-"));

  try {
    await writeProject(dir, project);
    await input.emit("info", "-> self-check: installing the project as the commit will leave it, and running its real build");

    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const install = await runCommand(
      npm,
      ["install", "--no-audit", "--no-fund", "--loglevel=error"],
      dir,
      INSTALL_TIMEOUT_MS,
      process.platform === "win32",
    );
    if (install.code !== 0) {
      await input.emit("warn", `self-check skipped — the sandbox install failed (${install.out.trim().slice(0, 200)})`);
      /* Unknown is not clean: a caller must not read "the round landed" as
         "the defects are gone" when nothing was actually checked. */
      return { files: changed, tokens, cleared: false };
    }

    /* The check is the verifier's own command — the project's real build — not
       a bare type check. A screen that reads localStorage while rendering
       type-checks perfectly and then dies while prerendering; only the build
       sees that. What passes here is what the verifier will see. */
    const build = () =>
      runCommand(npm, ["run", "build"], dir, BUILD_TIMEOUT_MS, process.platform === "win32");

    let check = await build();
    if (check.code === 0) {
      await input.emit(
        "success",
        `self-check passed — the merged project builds clean (${Math.round((Date.now() - started) / 1000)}s)`,
      );
      return { files: changed, tokens, cleared: true };
    }

    let errors = check.out.trim().slice(0, MAX_REPORTED_ERRORS);
    await input.emit("warn", `self-check: the build rejects the project — ${firstErrorLine(errors)}`);

    let current = changed;
    for (let attempt = 1; attempt <= SELF_CHECK_REPAIRS; attempt += 1) {
      await input.heartbeat();
      const repaired = await repairWithCompiler(input, currentProject, errors, attempt);
      tokens += repaired.tokens;

      if (repaired.files.length === 0) {
        await input.emit("warn", `-> build repair ${attempt}/${SELF_CHECK_REPAIRS}: the model returned nothing usable`);
        continue;
      }

      current = mergeRepairs(current, repaired.files);
      currentProject = mergeRepairs(currentProject, repaired.files);
      await writeProject(dir, repaired.files);
      check = await build();

      if (check.code === 0) {
        await input.emit(
          "success",
          `-> build repair ${attempt}/${SELF_CHECK_REPAIRS} cleared it — the project builds clean`,
        );
        return { files: current, tokens, cleared: true };
      }

      errors = check.out.trim().slice(0, MAX_REPORTED_ERRORS);
      await input.emit("warn", `-> build repair ${attempt}/${SELF_CHECK_REPAIRS} still fails — ${firstErrorLine(errors)}`);
    }

    /* Honest fallback. Claiming a clean build here would make the dashboard lie
       about a codebase that does not compile. */
    await input.emit(
      "warn",
      `self-check could not clear the build in ${SELF_CHECK_REPAIRS} repair round(s) — committing the real state so the verifier reports it`,
    );
    return { files: current, tokens, cleared: false };
  } catch (error) {
    await input.emit(
      "warn",
      `self-check could not run (${error instanceof Error ? error.message : String(error)}) — committing without it`,
    );
    return { files: changed, tokens, cleared: false };
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
}

/** Ask the model to repair the project against the compiler's own output. The
    errors name the files; those files' contents, the shared kit and the
    project's lib/ modules travel with the request, because the defect is
    usually a contract between two files, not a mistake inside one. */
export async function repairWithCompiler(
  input: CodeInput,
  files: GeneratedFile[],
  errors: string,
  attempt: number,
): Promise<{ files: GeneratedFile[]; tokens: number }> {
  const named = new Set<string>();
  for (const match of errors.matchAll(/([A-Za-z0-9_@./-]+\.(?:tsx|ts|jsx|js))\((\d+),(\d+)\)/g)) {
    named.add(match[1].replace(/^\.\//, "").replace(/^\//, ""));
  }

  const suspects = files.filter((f) => named.has(f.path)).slice(0, 4);
  const shared = files.filter((f) => /^(components\/ui|lib\/)/.test(f.path)).slice(0, 3);
  const show = [...new Set([...suspects, ...shared])].slice(0, 6);

  const context = show.map((f) => `--- ${f.path} ---\n${f.content.slice(0, 8_000)}`).join("\n\n");

  const chatInput: ChatInput = {
    tier: input.plan.modelTier,
    userId: input.userId,
    agent: "code",
    preferred: input.preferredModel ?? defaultModelFor(input.plan.modelTier),
    timeoutMs: 240_000,
    maxRungs: 10,
    onAttempt: async (a) => {
      await input.emit(
        a.ok ? "success" : "warn",
        `  repair ${attempt} · model ${a.provider}/${a.model} ${a.ok ? "answered" : `failed (${a.detail ?? "unknown"})`} in ${Math.round(a.ms / 1000)}s`,
      );
    },
  };

  const prompt = `The TypeScript compiler rejected this Next.js project before its commit. Fix exactly what it reports, and return the COMPLETE corrected contents of only the files that need changing.

Reply with ONLY a JSON object of the shape:
{ "files": [ { "path": "...", "content": "<the complete corrected file>" } ] }

COMPILER OUTPUT (tsc --noEmit, verbatim)
${errors}

CURRENT CONTENTS
${context}

RULES
- Return complete files only. A file that ends mid-function, mid-object or mid-JSX is another failed build — if space is tight, simplify styling, never cut logic.
- Two different declarations that share one name are printed as that single name (a mismatch often reads as "MatchHistory | MatchHistory"). When a value is rejected — at a setState boundary, say — check whether the type really lives in another file: if it does, delete the local declaration and import that type instead, and do not silence it with "as X".
- Keep everything that already works; change only what the errors require.
- Do not create package.json, tsconfig.json, next.config.mjs, postcss.config.mjs, app/layout.tsx, app/globals.css, components/ui.tsx or lib/persist.ts.`;

  const { value, result } = await chatJson<{ files?: GeneratedFile[] }>(chatInput, [
    {
      role: "system",
      content:
        "You are a senior TypeScript engineer repairing a Next.js App Router project that fails to compile. You return complete corrected files, and you never cast around a type error — you fix the type. Think briefly, then answer — your reply budget is finite and the fix matters more than deliberation.",
    },
    { role: "user", content: prompt },
  ]);

  if (!result.ok || !value) return { files: [], tokens: result.tokens };
  return { files: sanitize(value.files ?? []), tokens: result.tokens };
}

/* ————————————————————————— the scaffold ————————————————————————— */

/** Storage access that is safe during the server render, written by the harness
    rather than by a model.

    Every product this pipeline builds persists to localStorage, and every
    screen prerenders during the build — where localStorage does not exist. The
    obvious model-written line, useState(() => localStorage.getItem(key)), type
    checks perfectly and then fails the build while prerendering that page. The
    helper exists so the safe path is also the easy one: the model is told its
    exact API instead of being trusted to remember why render is not a browser. */
const PERSIST_HELPER = `/* localStorage, safe on the server. Prerendering happens without a browser, so
   a direct read during render fails the build — everything goes through here. */

export function readLocal<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — losing a cache must never break a screen */
  }
}
`;

/** The shared kit, written by the harness rather than by a model. */
const UI_KIT = `/* The shared UI kit — harness-owned, like the scaffold around it.

Parallel workers negotiate interfaces badly: one screen asks for
variant=\"outline\" while the kit only defines three variants, and the app dies
in type check. These signatures are fixed and every screen is told them
exactly, so a prop name never costs a fix round. */

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "outline" | "ghost" | "link";
export type ButtonSize = "sm" | "md" | "lg";
export type Tone = "brand" | "pass" | "warn" | "bad" | "neutral";

export function Button({
  children,
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}) {
  const base = "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50";
  const sizes: Record<ButtonSize, string> = {
    sm: "h-8 px-3 text-xs",
    md: "h-10 px-4 text-sm",
    lg: "h-12 px-6 text-[15px]",
  };
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-[var(--accent)] text-black hover:opacity-90",
    secondary: "bg-[var(--surface)] text-[var(--primary)] border border-white/10 hover:border-white/25",
    danger: "bg-red-500/15 text-red-300 border border-red-500/40 hover:bg-red-500/25",
    outline: "border border-white/25 text-[var(--primary)] hover:border-white/45 hover:bg-white/5",
    ghost: "text-[var(--primary)] hover:bg-white/10",
    link: "text-[var(--accent)] underline underline-offset-4 hover:opacity-80",
  };

  return (
    <button
      type="button"
      className={base + " " + sizes[size] + " " + variants[variant] + " " + className}
      {...props}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = "", ...props }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) {
  return (
    <div className={"rounded-xl border border-white/10 bg-[var(--surface)] p-4 " + className} {...props}>
      {children}
    </div>
  );
}

export function Badge({ children, tone = "neutral", className = "" }: { children?: ReactNode; tone?: Tone; className?: string }) {
  const tones: Record<Tone, string> = {
    brand: "bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/30",
    pass: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    warn: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    bad: "bg-red-500/15 text-red-300 border-red-500/30",
    neutral: "bg-white/5 text-white/60 border-white/10",
  };
  return (
    <span className={"inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium " + tones[tone] + " " + className}>
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  message,
  description,
  icon,
  action,
  className = "",
}: {
  title?: ReactNode;
  message?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const heading = title ?? message ?? "Nothing here yet";
  const body = description ?? (title != null && message != null && message !== title ? message : null);
  return (
    <div className={"flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/15 bg-white/[0.02] px-6 py-10 text-center " + className}>
      {icon ? <div className="text-white/50">{icon}</div> : null}
      <p className="text-sm font-medium text-white/80">{heading}</p>
      {body ? <p className="max-w-sm text-xs text-white/50">{body}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function ListRow({
  record,
  title,
  subtitle,
  trailing,
  children,
  className = "",
}: {
  record?: Record<string, unknown>;
  title?: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const pick = (keys: string[]): string | null => {
    if (!record) return null;
    for (const k of keys) {
      const v = record[k];
      if (typeof v === "string" || typeof v === "number") return String(v);
    }
    return null;
  };
  const heading = title ?? pick(["title", "name", "label"]) ?? "Untitled";
  const sub = subtitle ?? pick(["notes", "description", "subtitle", "createdAt"]);
  const aside = trailing ?? children;
  return (
    <div className={"flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 " + className}>
      <div className="min-w-0">
        <p className="truncate text-sm text-white/85">{heading}</p>
        {sub ? <p className="truncate text-xs text-white/45">{sub}</p> : null}
      </div>
      {aside ? <div className="shrink-0 text-xs text-white/50">{aside}</div> : null}
    </div>
  );
}
`;

/** The files the harness owns. Written here, never by a model, so the result
    always installs and always builds. Versions are pinned to what this pipeline
    is known to work with. */
function scaffold(input: CodeInput): GeneratedFile[] {
  const productName = input.master?.productName ?? input.sentence;

  return [
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: input.slug,
          version: "0.1.0",
          private: true,
          scripts: { dev: "next dev", build: "next build", start: "next start" },
          /* Pinned to the exact trio this platform itself builds with on
             Vercel. Older Next majors are rejected at deploy time as
             vulnerable — which is a deploy-stage failure, not a fix round. */
          dependencies: { next: "16.3.6", react: "19.2.8", "react-dom": "19.2.8" },
          devDependencies: {
            "@tailwindcss/postcss": "^4",
            "@types/node": "^20",
            "@types/react": "^19",
            "@types/react-dom": "^19",
            postcss: "^8",
            tailwindcss: "^4",
            typescript: "^5",
          },
        },
        null,
        2,
      ),
    },
    {
      path: "tsconfig.json",
      content: JSON.stringify(
        {
          compilerOptions: {
            target: "ES2017",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "preserve",
            incremental: true,
            plugins: [{ name: "next" }],
            paths: { "@/*": ["./*"] },
          },
          include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
          exclude: ["node_modules"],
        },
        null,
        2,
      ),
    },
    {
      path: "next.config.mjs",
      content: `/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nexport default nextConfig;\n`,
    },
    {
      path: "postcss.config.mjs",
      content: `const config = { plugins: ["@tailwindcss/postcss"] };\n\nexport default config;\n`,
    },
    {
      path: "app/globals.css",
      content: `@import "tailwindcss";\n\n:root {\n  --background: ${input.master?.design.colors.background ?? "#0b0d10"};\n  --surface: ${input.master?.design.colors.surface ?? "#14171c"};\n  --primary: ${input.master?.design.colors.primary ?? "#e6e9ef"};\n  --accent: ${input.master?.design.colors.accent ?? "#4f8cff"};\n}\n\nbody {\n  background: var(--background);\n  color: var(--primary);\n}\n`,
    },
    {
      path: "app/layout.tsx",
      content: `import type { Metadata } from "next";\nimport "./globals.css";\n\nexport const metadata: Metadata = {\n  title: ${JSON.stringify(productName)},\n  description: ${JSON.stringify(input.master?.tagline ?? input.sentence)},\n};\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
    },
    {
      /* The shared kit is harness-owned for the same reason package.json is:
         two workers writing the screens in parallel cannot negotiate an API,
         and a guessed prop name (`variant="outline"`, `<EmptyState title=…>`)
         does not surface until type check — one round later, in a codebase the
         fixer is also guessing at. Written here, it is the one thing in the
         project every file can import without asking. */
      path: "components/ui.tsx",
      content: UI_KIT,
    },
    {
      /* The safe storage read. Harness-owned for the same reason the kit is:
         one file every worker can import without negotiating, and no way for a
         screen to touch localStorage during the server render. */
      path: "lib/persist.ts",
      content: PERSIST_HELPER,
    },
  ];
}

/** Merge the model's files over the scaffold. The scaffold wins on its own
    paths, which is the guarantee described at the top of this file. */
function mergeScaffold(files: GeneratedFile[], input: CodeInput): GeneratedFile[] {
  const base = scaffold(input);
  const byPath = new Map<string, GeneratedFile>();

  for (const file of base) byPath.set(file.path, file);
  for (const file of files) {
    if (isScaffold(file.path)) continue;
    byPath.set(file.path, file);
  }

  /* Guarantee a page exists even if the model wrote none — otherwise the build
     has no route to render. */
  if (!byPath.has("app/page.tsx")) {
    byPath.set("app/page.tsx", fallbackPage(input));
  }

  return [...byPath.values()];
}

/** A working page derived from the spec. Used when no model answered, and as
    the last-resort root route. Plain, but real: it renders the flows as a
    usable list-backed screen with localStorage persistence, which is enough for
    the verifier and the browser test to have something true to check. */
function fallbackPage(input: CodeInput): GeneratedFile {
  const spec = input.spec;
  const table = spec?.dataModel[0]?.table ?? "items";
  const name = input.master?.productName ?? input.sentence;
  const flows = (spec?.flows ?? []).map((f) => f.name);

  return {
    path: "app/page.tsx",
    content: `"use client";

import { useEffect, useState } from "react";

/* Generated by LastMile without a model. The flows below come from the product
   spec; the screens are deliberately plain so the result is honest about how it
   was made. */

type RecordItem = { id: string; title: string; notes: string; createdAt: string };

const KEY = ${JSON.stringify(`lastmile:${input.slug}:${table}`)};

export default function Page() {
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) setRecords(JSON.parse(raw) as RecordItem[]);
    } catch {
      /* a corrupt value must not break the first render */
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(records));
    } catch {
      /* storage full or blocked — the UI stays usable */
    }
  }, [records, ready]);

  function add(e: React.FormEvent) {
    e.preventDefault();
    const clean = title.trim();
    if (!clean) return;
    setRecords((r) => [
      { id: crypto.randomUUID(), title: clean, notes: notes.trim(), createdAt: new Date().toISOString() },
      ...r,
    ]);
    setTitle("");
    setNotes("");
  }

  function remove(id: string) {
    setRecords((r) => r.filter((x) => x.id !== id));
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">${name}</h1>
      <p className="mt-2 text-sm opacity-70">${input.master?.tagline ?? input.sentence}</p>

      <form onSubmit={add} className="mt-8 space-y-3 rounded-lg border border-white/10 p-4">
        <label className="block text-xs uppercase tracking-widest opacity-60" htmlFor="title">
          Title
        </label>
        <input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded border border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          placeholder="What needs recording?"
        />
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full resize-none rounded border border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          placeholder="Notes (optional)"
        />
        <button
          type="submit"
          className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
          disabled={title.trim().length === 0}
        >
          Add
        </button>
      </form>

      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-widest opacity-60">
          {records.length === 0 ? "Nothing yet" : records.length + " saved"}
        </h2>

        {records.length === 0 ? (
          <p className="mt-3 rounded border border-dashed border-white/15 px-4 py-8 text-center text-sm opacity-70">
            Add the first one above — it is saved in this browser and survives a reload.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {records.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-4 rounded border border-white/10 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{r.title}</p>
                  {r.notes ? <p className="mt-0.5 text-xs opacity-70">{r.notes}</p> : null}
                </div>
                <button onClick={() => remove(r.id)} className="shrink-0 text-xs opacity-60 hover:opacity-100">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="mt-12 border-t border-white/10 pt-4 text-xs opacity-50">
        Flows: ${flows.join(" · ") || "add and list"}
      </footer>
    </main>
  );
}
`,
  };
}

/** Exported so a caller can tell whether a file is harness-owned. */
export { isScaffold, latestSha };
