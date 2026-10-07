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
import { commitFiles, ensureRepo, latestSha } from "../platform/github";
import type { PlanConfig } from "../plans";

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
  const tokens = generated.tokens;
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

  /* ————— 3. commit ————— */

  const commit = await commitFiles({
    owner,
    name,
    files: files.map((f) => ({ path: f.path, content: f.content })),
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
    reason: generated.ok ? undefined : reason,
  };
}

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
    packages.push({
      label: "shared components",
      files: ["components/ui.tsx"],
      brief: "The shared UI pieces the other screens import — buttons, cards, list rows, empty states — matching the design system exactly.",
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
        maxRungs: 6,
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
            "You are a worker coding agent. You build ONE part of a larger Next.js product, exactly to your brief. You write complete, working code — no placeholders, no TODOs. You return ONLY files in your own scope.",
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
- Persistence: localStorage, key exactly "${key}" — the other screens read the same key, so the product works as one.
- Shared record type (match this exactly): type Record = { id: string; title: string; notes: string; createdAt: string }.
- If you import a shared component, import it from "@/components/ui" — that file is written by another worker with exports: Card, Button, EmptyState, ListRow.
- Write REAL content for this specific product. No lorem ipsum, no placeholders, no TODOs.
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
    maxRungs: 6,
    onAttempt: async (attempt) => {
      await input.emit(
        attempt.ok ? "success" : "warn",
        `  model ${attempt.provider}/${attempt.model} ${attempt.ok ? "answered" : `failed (${attempt.detail ?? "unknown"})`} in ${Math.round(attempt.ms / 1000)}s`,
      );
    },
  };

  const prompt = input.firstPass
    ? buildPrompt(input)
    : fixPrompt(input);

  const { value, result, parseError } = await chatJson<{ files?: GeneratedFile[] }>(chatInput, [
    {
      role: "system",
      content:
        "You are a senior front-end engineer. You write complete, working Next.js App Router code. You never write placeholders, TODOs, or comments explaining what code should do — you write the code.",
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

function buildPrompt(input: CodeInput): string {
  const master = input.master;
  const spec = input.spec;

  return `Build the complete product described below. Reply with ONLY a JSON object of the shape:
{ "files": [ { "path": "app/page.tsx", "content": "..." } ] }

STRICT RULES
- Next.js App Router with TypeScript. Every page is a client component ("use client").
- Styling: Tailwind utility classes only. No CSS modules, no styled-components.
- Persistence: localStorage only. There is no backend and no database.
- Write REAL content for this specific product. No lorem ipsum, no placeholders, no TODOs.
- EVERY file must be COMPLETE from its first line to its last. A file that ends mid-function, mid-object or mid-JSX is a failed build. If you are running short on space, simplify styling and commentary — never stop before the file is finished and syntactically whole.
- Do not create: package.json, tsconfig.json, next.config.mjs, postcss.config.mjs, app/layout.tsx, app/globals.css. Those already exist and are correct — any file you return with those paths is discarded.
- Files you SHOULD write: app/page.tsx plus any routes in the spec, and components/ files for the parts that are reused.
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

function fixPrompt(input: CodeInput): string {
  return `Fix defects in an existing Next.js product. Reply with ONLY:
{ "files": [ { "path": "...", "content": "<the complete corrected file>" } ] }

Return the COMPLETE corrected contents of only the files that need changing — not a diff, not a fragment.
A file that ends mid-function, mid-object or mid-JSX is a failed build — if space is tight, simplify styling, never cut logic.
Do not create package.json, tsconfig.json, next.config.mjs, app/layout.tsx or app/globals.css.
Keep everything that already works; change only what the defects require.

FILES THE DEFECTS POINT AT
${(input.files ?? []).join("\n") || "(the defects did not name files — find them yourself)"}
${input.deployError ? `
DEPLOY FAILURE (the hosting platform rejected the build — fix what it names)
${input.deployError.slice(0, 2000)}` : ""}

MASTER BUILD PROMPT (the contract the code is held to)
${input.master?.instructions ?? input.sentence}`;
}

/* ————————————————————————— validation ————————————————————————— */

const ALLOWED_EXT = /\.(tsx|ts|jsx|js|css|json|md)$/i;
const FORBIDDEN = /(^|\/)(package\.json|package-lock\.json|tsconfig\.json|next\.config\.[a-z]+|postcss\.config\.[a-z]+|app\/layout\.tsx|app\/globals\.css)$/i;

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

/* ————————————————————————— the scaffold ————————————————————————— */

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

type Record = { id: string; title: string; notes: string; createdAt: string };

const KEY = ${JSON.stringify(`lastmile:${input.slug}:${table}`)};

export default function Page() {
  const [records, setRecords] = useState<Record[]>([]);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) setRecords(JSON.parse(raw) as Record[]);
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
