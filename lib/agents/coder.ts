import { exec } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentChat } from "@/lib/ai/registry";
import { asObjectArray, asString, extractJson, salvageFiles } from "@/lib/ai/json";
import type { Emit, MasterBuildPrompt } from "./prompt-engineer";
import { writeFiles, workspaceDir, fileCount, listFiles, readWorkspaceFile, type WorkspaceFile } from "@/lib/platform/workspace";
import type { PlanId } from "@/lib/platform/settings";

/* ════════════════════════════════════════════════════════════════════
   CODING AGENT — turns the Master Build Prompt into a real codebase.

   Architecture (v2, rewritten):

     1. DETERMINISTIC SCAFFOLD — package.json / tsconfig / next.config /
        postcss are written by the platform, never the model. The build
        target is coherent before a single model token is spent.

     2. ONE FILE PER REQUEST — a plan pass lists the modules, then each
        file gets its own bounded request, written in parts when big, with
        a raw-source fallback for models that cannot nest code in JSON.
        Modules are generated BEFORE the page that imports them, and every
        request is handed the REAL exported surface of what already exists
        on disk, so cross-file contracts are quoted, not remembered.

     3. HERMETIC EXECUTION — every child process (npm install, tsc, next
        build, and the build workers Next itself spawns) runs in a
        SANITIZED environment. This is not cosmetic: spawned from the
        running dev server, a build used to inherit that process's private
        state — __NEXT_PRIVATE_PREBUNDLED_REACT, NODE_OPTIONS,
        npm_config_local_prefix pointing at THIS platform's tree — and
        would then fail with errors ("<Html> should not be imported
        outside of pages/_document", ghost /_error pages) that reference
        code the workspace does not even contain, while the identical tree
        built perfectly by hand. The env blocklist below is the fix; the
        failure that ate seven runs died here.

     4. SELF-CHECKING GATE — npm install + tsc + next build run for real,
        always on a clean .next (a stale cache re-exports the artifacts of
        a broken round forever), and every failure is sent back to the
        model as a patch request with the real log, the missing modules,
        and the exported surfaces of the whole tree — for up to three
        rounds. A build that never passed never leaves this stage.
   ════════════════════════════════════════════════════════════════════ */

/* ------------------------------------------------------------------ *
 * Deterministic scaffold
 * ------------------------------------------------------------------ */

const SCAFFOLD_TS_CONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*", "./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", "cypress", "e2e", "tests", "test", "__tests__", "**/*.cy.ts", "**/*.cy.tsx", "**/*.spec.ts", "**/*.spec.tsx", "**/*.test.ts", "**/*.test.tsx"]
}`;

const SCAFFOLD_POSTCSS = `const config = { plugins: { "@tailwindcss/postcss": {} } };\nexport default config;`;

const SCAFFOLD_NEXT_CONFIG = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // the real quality gates are TypeScript strict + the live QA agent.
  // generated apps ship no eslint config, so a build must not depend on
  // lint defaults that change between Next releases.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;`;

const SCAFFOLD_ENV_DTS = `/// <reference types="next" />\\n/// <reference types="next/image-types/global" />

// declare CSS modules so side-effect "import './globals.css'" never fails TS
// (CSS Modules are always available at build time, even when TS kind of pretends otherwise).
declare module "*.css" {
  const content: Record<string, string>;
  export default content;
}
`;

function scaffold(_name: string, slug: string): WorkspaceFile[] {
  return [
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: slug,
          version: "1.0.0",
          private: true,
          scripts: { dev: "next dev", build: "next build", start: "next start" },
          dependencies: {
            next: "^15.5.4",
            react: "^19.1.0",
            "react-dom": "^19.1.0",
          },
          devDependencies: {
            "@tailwindcss/postcss": "^4.1.0",
            "@types/node": "^22.0.0",
            "@types/react": "^19.1.0",
            "@types/react-dom": "^19.1.0",
            tailwindcss: "^4.1.0",
            typescript: "^5.8.0",
          },
        },
        null,
        2,
      ),
    },
    { path: "tsconfig.json", content: SCAFFOLD_TS_CONFIG },
    { path: "postcss.config.mjs", content: SCAFFOLD_POSTCSS },
    { path: "next.config.ts", content: SCAFFOLD_NEXT_CONFIG },
    { path: "next-env.d.ts", content: SCAFFOLD_ENV_DTS },
    {
      path: ".gitignore",
      content: "node_modules/\n.next/\nout/\n.env*.local\n.vercel\n*.tsbuildinfo\n",
    },
  ];
}

/* ------------------------------------------------------------------ *
 * The model's standing orders
 * ------------------------------------------------------------------ */

const CODER_SYSTEM = `You are the Core Coding Agent of LastMile. You write complete, production-grade Next.js code from the master build prompt you are given.

Stack (fixed — never change it): Next.js 15 App Router, React 19, TypeScript strict, Tailwind v4. No other framework, no other router.

Rules:
- Output real files, complete — never placeholders, never "// TODO", never truncated code.
- TypeScript strict mode must pass. Every prop typed. No any types.
- Tailwind v4 (CSS-first: @import "tailwindcss"; in globals.css). No tailwind.config needed.
- App Router ONLY. NEVER create a pages/ directory. NEVER import from "next/document" or "next/head" — <html> and <body> belong in app/layout.tsx alone. Violating this fails the build with "<Html> should not be imported outside of pages/_document", which no fix round can repair.
- Fonts via the CSS font stack in globals.css. Never next/font (it fetches from the network at build time).
- Client-side persistence only (localStorage). "use client" on interactive components.
- The app must build with zero errors and run with zero console errors.
- No hydration mismatches: the server render must equal the first client render.
  Any localStorage/session value is read in a useEffect that also flips a
  ready boolean, and the parts that depend on it render a safe placeholder
  until that boolean is true. Never read localStorage during module init or render.
- React 19 types: NEVER use the global JSX namespace. Type component returns
  as React.ReactElement / React.ReactNode, or omit the annotation entirely.
  Every export that another file imports must be exported with the exact name the importer uses.
- No npm dependencies beyond next/react/react-dom — everything else is hand-written.
- NO test frameworks. Never write Cypress, Playwright, Jest or Vitest files (no *.cy.ts, *.spec.ts, *.test.ts, no cypress/ directory) — the platform runs its own live QA against the deployed app.
- Accessibility: label every control, semantic HTML, focus states.`;

/* ------------------------------------------------------------------ *
 * Path guards — what the model may never touch
 * ------------------------------------------------------------------ */

/** Files the platform owns; the model must never emit them. */
const FORBIDDEN_PATH =
  /^(package\.json|package-lock\.json|tsconfig[^/]*\.json|next\.config\.[a-z]+|postcss\.config\.[a-z]+|next-env\.d\.ts|\.gitignore|tailwind\.config\.[a-z]+|\.?eslintrc[a-z.]*|eslint\.config\.[a-z]+|\.env|\.env\.[a-z]+)$/i;

const JUNK_EXT = /\.(bak|tmp|orig|copy|log|swp)$/i;
const KNOWN_EXT = /\.(tsx?|jsx?|mjs|cjs|css|md|txt|json|ya?ml|example|svg|png|jpg|jpeg|ico|webmanifest|html)$/i;

/** The scaffold's single page component. Next allows exactly ONE module to own
    a route path, so a second one at the same path is an instant build failure:
    "You cannot have two parallel pages that resolve to the same path."

    This bit hardest in the fix loops. A reviewer that reads the user's literal
    prompt ("just a page with hello world, nothing else") will ask for a
    text/plain body, and the obvious way to serve that in the App Router is an
    app/route.ts — which collides head-on with app/page.tsx at "/". The model
    cannot delete the page, so it rewrote both files over and over and every
    round failed with the identical error. Two defences below: the root is a
    reserved route for route handlers, and the model may now delete files. */
const PAGE_ROUTES = ["app/page.tsx", "app/page.ts", "app/page.jsx", "app/page.js"];

/** Route handlers that would collide with the scaffold's own page at "/". */
function isRootRouteHandler(p: string): boolean {
  return p === "app/route.ts" || p === "app/route.tsx" || p === "app/route.js" || p === "app/route.jsx";
}

/** A path the model may write at any time (patches included). */
function writePathAllowed(p: string): boolean {
  return (
    !FORBIDDEN_PATH.test(p) &&
    !JUNK_EXT.test(p) &&
    KNOWN_EXT.test(p) &&
    !p.includes("..") &&
    !isRootRouteHandler(p) && // app/page.tsx already owns "/" — a root route handler is a hard build error
    !/^src\//i.test(p) && // the scaffold's app dir lives at the root; a second src/ tree always breaks the build
    // App Router only. A stray Pages-Router tree makes Next treat these as
    // real pages, and a pages/_error.tsx (or anything importing next/document)
    // fails the build outright with "<Html> should not be imported outside of
    // pages/_document" — a failure the patch loop cannot see or fix.
    !/^pages\//i.test(p) &&
    // No test-runner files. The platform's QA is the Testing Agent against
    // the deployed URL; Cypress/Playwright/Jest specs cannot typecheck here
    // (their globals come from deps the scaffold deliberately does not
    // install) and 41 "Cannot find namespace 'Cypress'" errors once burned
    // every fix round of a run.
    !/^(cypress|e2e|tests|test|__tests__)\//i.test(p) &&
    !/\.cy\.[tj]sx?$|\.spec\.[tj]sx?$|\.test\.[tj]sx?$/i.test(p)
  );
}

/** A path the PLANNER may list as a new file: no pages (owned by pass 2), no src/, api routes fine. */
function planPathAllowed(p: string): boolean {
  if (!writePathAllowed(p)) return false;
  if (/^src\//i.test(p)) return false;
  if (/^app\//i.test(p) && !/^app\/api\//i.test(p)) return false; // pages/layouts/globals come from the dedicated passes
  return true;
}

/** Remove everything model-writable so a retry starts from a clean, coherent tree.
 *  node_modules survives (it is the slow part); the .next cache must NOT: a
 *  stale chunk from a crashed attempt makes `next build` fail with errors that
 *  reference code the current sources do not even contain. */
function resetWorkspaceSources(runId: string): void {
  const dir = workspaceDir(runId);
  for (const entry of ["app", "src", "components", "hooks", "lib", "utils", "types", "tests", "test", "__tests__", "cypress", "e2e", "playwright-report", "test-results", "public", "styles", "pages", "README.md", ".env.example", ".next", "tsconfig.tsbuildinfo", "node_modules/.cache", "tmp-build.log"]) {
    try {
      rmSync(join(dir, entry), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Request templates — small, single-purpose, truncation-proof.
 * ------------------------------------------------------------------ */

const STACK_LINE = `Stack: Next.js 15 App Router + React 19 + TypeScript strict + Tailwind v4. Never import next/document or next/head; never create a pages/ directory; never next/font.`;

function shellStaticPass(master: MasterBuildPrompt): string {
  return `${master.instructions}

${STACK_LINE}

Write exactly TWO files — the app shell:
1. "app/globals.css" — Tailwind v4 (@import "tailwindcss";), the design tokens as CSS variables (${master.design.colors.background} / ${master.design.colors.surface} / ${master.design.colors.primary} / ${master.design.colors.accent}), font setup via a plain CSS font stack, focus styles.
2. "app/layout.tsx" — metadata (title "${master.productName} — ${master.tagline}"), lang, body classes. Plain <html> and <body> JSX — no next/document import.

Return ONLY valid JSON: {"files": [{"path": "app/globals.css", "content": "..."}, {"path": "app/layout.tsx", "content": "..."}]}`;
}

function filePlanPass(master: MasterBuildPrompt): string {
  return `${master.instructions}

${STACK_LINE}

Before any code is written: plan the file layout of the product.

Plan rules:
- 2 to 10 files. Prefer few, well-factored files.
- List every component, hook and lib module the product needs. Each must carry a one-line purpose.
- Include "README.md" as the last entry.
- No pages, no layouts, no "app/page.tsx", no config files, no npm dependencies — the platform owns those.
- Write paths relative to the project root ("components/Board.tsx", "lib/game.ts", "hooks/useScores.ts").

Return ONLY valid JSON: {"files": [{"path": "components/Board.tsx", "purpose": "one line"}]}`;
}

/** Read workspace source files for inclusion in a patch prompt.
 *  Caps total size so the prompt itself can never truncate the answer. */
function snapshotFiles(runId: string, wanted: string[] | null, budget = 24_000): string {
  const dir = workspaceDir(runId);
  const all = listAll(runId).filter((f) => /\.(ts|tsx|js|jsx|css|json)$/.test(f) && !f.includes(".next"));
  const chosen = wanted && wanted.length > 0 ? all.filter((f) => wanted.some((w) => f === w || f.endsWith("/" + w) || w.endsWith("/" + f))) : all;
  const list = chosen.length > 0 ? chosen : all;
  const parts: string[] = [];
  let used = 0;
  for (const rel of list) {
    let text: string;
    try {
      text = readFileSync(join(dir, rel), "utf8");
    } catch {
      continue;
    }
    if (used + text.length > budget) text = text.slice(0, Math.max(0, budget - used)) + "\n/* ... truncated ... */";
    parts.push(`--- ${rel} ---\n${text}`);
    used += text.length;
    if (used >= budget) break;
  }
  return parts.join("\n\n");
}

function patchPass(master: MasterBuildPrompt, issueBlock: string, currentFiles: string[], sources: string): string {
  return `${master.instructions}

${STACK_LINE}

The app is built from these files:
${currentFiles.join("\n")}

Current source of the relevant files:
${sources}

QA found these defects. Fix them at the root cause:
${issueBlock}

Return ONLY the files that must change (full new content, not diffs):
{"files": [{"path": "...", "content": "..."}], "delete": ["path/to/obsolete-file.tsx"]}

Use "delete" ONLY for files that must genuinely stop existing. Two modules can
never own the same route path, so if you are asked to serve a path that another
file already owns, keep exactly ONE of them and delete the other.

app/page.tsx is the ONE module that serves "/" and it can never be deleted,
renamed, or replaced by app/route.ts. If a review asks for behaviour that
app/page.tsx cannot express, implement the closest thing it CAN express inside
app/page.tsx — never move the home page to another path, and never delete the
page to satisfy a request for a different Content-Type. A site whose home page
is gone returns 404 at its own root.`;
}

/* ------------------------------------------------------------------ *
 * Model calls
 * ------------------------------------------------------------------ */

async function modelCall(
  plan: PlanId,
  userPrompt: string,
  maxTokens: number,
  timeoutMs: number,
  /** request JSON mode; false for the raw-source fallback, where asking for a
      JSON string containing a whole file is what the model keeps failing at */
  json = true,
): Promise<string> {
  const res = await agentChat(
    plan,
    "code",
    [
      { role: "system", content: CODER_SYSTEM },
      { role: "user", content: userPrompt },
    ],
    { temperature: 0.25, maxTokens, json, timeoutMs },
  );
  return res.text;
}

/** Strip a markdown fence a model wrapped around raw source. */
function stripFences(text: string): string {
  return text
    .replace(/^\s*```[a-z]*\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

/** Cheap completeness signal for raw source: string/comment-aware brace
    balance. Used only to decide whether a raw answer is worth keeping — the
    real gate is still the build. */
function looksComplete(code: string): boolean {
  let depth = 0;
  let inStr: string | null = null;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    const next = code[i + 1];
    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
    } else if (c === "/" && next === "*") {
      inBlock = true;
      i++;
    } else if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return depth === 0 && !inStr && !inBlock;
}

/** Parse one or more files out of a model response.
 *  Salvage keeps complete {path, content} objects even when the JSON as a
 *  whole is truncated — a cut-off response no longer loses finished files. */
function parseFiles(text: string): WorkspaceFile[] {
  const norm = (f: Record<string, unknown>): WorkspaceFile => ({
    path: asString(f.path).replace(/^\/+/, ""),
    content: asString(f.content),
  });
  const usable = (list: WorkspaceFile[]) => list.filter((f) => f.path && f.content.length > 20);

  const json = extractJson<Record<string, unknown>>(text);
  if (json) {
    // a bare top-level array of file objects is a shape free models emit
    // constantly, and rejecting it threw away the whole answer every time
    if (Array.isArray(json)) {
      const files = usable((json as unknown as Record<string, unknown>[]).map(norm));
      if (files.length > 0) return files;
    }
    if (typeof json.content === "string" && json.content.trim().length > 20) {
      const p = asString(json.path).replace(/^\/+/, "");
      return [{ path: p, content: json.content }];
    }
    const files = usable(asObjectArray(json.files, 16).map(norm));
    if (files.length > 0) return files;
  }

  // last resort for both "no JSON at all" and "JSON of the wrong shape":
  // salvage whole {path, content} objects out of a truncated or chatty answer
  const salvaged = usable(salvageFiles(text).filter((f) => !FORBIDDEN_PATH.test(f.path)));
  if (salvaged.length > 0) return salvaged;
  throw new Error(json ? "model produced no files" : "model returned no parseable file list");
}

async function writeAndAnnounce(runId: string, files: WorkspaceFile[], emit: Emit): Promise<void> {
  const safe = guardScaffold(files, emit);
  if (safe.length === 0) return;
  writeFiles(runId, safe);
  for (const f of safe) await emit({ kind: "info", line: `-> wrote ${f.path}` });
}

/* ── deletions ──────────────────────────────────────────────────────
   Some build failures are structural and cannot be repaired by writing:
   two modules owning the same route path, a stray pages/ tree, a file that
   exists only because an earlier round created it. The model cannot "write"
   its way out of those, so the patch response may also ask to DELETE. */

/** Pull a {"delete": ["path", ...]} list out of a model response. */
function parseDeletes(text: string): string[] {
  const json = extractJson<Record<string, unknown>>(text);
  if (!json) return [];
  const raw = Array.isArray(json.delete)
    ? json.delete
    : typeof json.delete === "string"
      ? [json.delete]
      : [];
  return raw
    .map((p) => asString(p).replace(/^\/+/, ""))
    .filter((p) => p.length > 0 && p.length < 200 && !p.includes("..") && KNOWN_EXT.test(p));
}

/** Delete the model's requested files, never a platform-owned one.
 *
 *  The scaffold's page component is protected here for the same reason the
 *  root route handler is blocked from being written: the two are competing
 *  solutions to one route, and letting the model pick the wrong one leaves
 *  "/" with no page at all. A run once resolved its collision by deleting
 *  app/page.tsx and moving the greeting to /hello — the site then deployed
 *  perfectly and served a 404 at its own root. Deleting the page is never the
 *  right answer, so it is refused and explained. */
async function applyDeletes(runId: string, paths: string[], emit: Emit): Promise<number> {
  let removed = 0;
  for (const rel of paths) {
    if (FORBIDDEN_PATH.test(rel) || rel.includes("..")) {
      await emit({ kind: "warn", line: `-> ignored model attempt to delete ${rel} (platform-owned or unsafe path)` });
      continue;
    }
    if (PAGE_ROUTES.includes(rel)) {
      await emit({
        kind: "warn",
        line: `-> refused to delete ${rel} — it is the page component that serves "/". Remove the conflicting route handler instead.`,
      });
      continue;
    }
    try {
      rmSync(join(workspaceDir(runId), rel), { force: true });
      removed++;
      await emit({ kind: "info", line: `-> deleted ${rel}` });
    } catch {
      /* already gone — deleting is idempotent */
    }
  }
  return removed;
}

/* ════════════════════════════════════════════════════════════════════
 * HERMETIC EXECUTION LAYER
 *
 * Every child process this agent spawns runs in a sanitized environment.
 * Spawned naked from the dev server, a build inherits that process's
 * private state — __NEXT_PRIVATE_PREBUNDLED_REACT (which silently swaps
 * the generated app's React for the dev server's prebundled one),
 * NODE_OPTIONS / NODE_COMPILE_CACHE, and the whole npm_config_* family
 * including npm_config_local_prefix, which told the child that THIS
 * platform's tree is the project root. The observable symptom was a
 * pages-router /_error export failing with "<Html> should not be
 * imported outside of pages/_document" on an app-router-only tree that
 * builds perfectly when run by hand — unfixable by patching, because the
 * sources were never wrong. The blocklist removes the entire class.
 * ════════════════════════════════════════════════════════════════════ */

const CHILD_ENV_BLOCKED: RegExp[] = [
  /^npm_config_/i, // npm_config_local_prefix etc. — the child must resolve its OWN project root from cwd
  /^npm_lifecycle_/i,
  /^npm_package_/i,
  /^npm_(node|command|execpath|cli|_)/i,
  /^NPM_/,
  /^NODE_/, // NODE_OPTIONS, NODE_ENV, NODE_PATH, NODE_COMPILE_CACHE, NODE_EXTRA_CA_CERTS…
  /^__NEXT_PRIVATE/i, // __NEXT_PRIVATE_PREBUNDLED_REACT and friends
  /^NEXT_PRIVATE/i,
  /^NEXT_/i, // NEXT_TELEMETRY (re-set explicitly), NEXT_RUNTIME, …
  /^TURBOPACK/i, // ⚠️ THE phantom: `next dev` exports TURBOPACK=1; a build that
  // inherits it is forced through Turbopack, whose pages-router built-ins
  // throw "<Html> should not be imported outside of pages/_document" during
  // the /404 prerender — on any tree, even ones that build perfectly by
  // hand. Every pre-rewrite failed run died here. (Proven by injection.)
  /^FORCE_COLOR/i,
];

/** The environment a build is allowed to see: the parent's neutral vars
    (PATH, SystemRoot, TEMP, …) minus every poisoned class, plus the three
    explicit pins the build actually needs. */
function childEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (CHILD_ENV_BLOCKED.some((re) => re.test(k))) continue;
    env[k] = v;
  }
  return { ...env, NODE_ENV: "production", CI: "1", NEXT_TELEMETRY_DISABLED: "1" };
}

/** Run a shell command in the workspace and capture output. */
function sh(cmd: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(
      cmd,
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: childEnv(), windowsHide: true },
      (err: Error | null, stdout: string, stderr: string) => {
        const output = ((stdout ?? "") + "\n" + (stderr ?? "")).replace(/\r/g, "");
        resolve({ ok: !err, output: output.slice(-6000) });
      },
    );
  });
}

/** Forensic probe: which NEXT-*, NODE-*, and npm-config variables did the
    child actually see? Written into the failure log, so an environment-caused
    build failure identifies itself instead of sending the coder chasing
    ghosts. Uses node -e so it is shell-independent (exec runs cmd.exe on
    Windows, where `env | grep` does not exist). */
function envProbe(): string {
  return (
    "node -e \"const e=Object.entries(process.env).filter(([k])=>/^(NEXT|NODE|NPM_CONFIG_(LOCAL_PREFIX|PREFIX|CACHE|REGISTRY|PROD|DEV|OMIT|USERCONFIG))/i.test(k));" +
    "console.log(e.map(([k,v])=>k+'='+String(v).slice(0,60)).join(' | '))\""
  );
}

/** npm install once; later rounds see node_modules and no-op in seconds. */
async function ensureDeps(runId: string, emit: Emit): Promise<boolean> {
  const dir = workspaceDir(runId);
  if (existsSync(join(dir, "node_modules", "next", "package.json"))) {
    await emit({ kind: "info", line: "-> dependencies already installed" });
    return true;
  }
  await emit({ kind: "command", line: "$ npm install --no-audit --no-fund" });
  const res = await sh("npm install --no-audit --no-fund", dir, 420_000);
  await emit({
    kind: res.ok ? "success" : "error",
    line: res.ok ? "-> dependencies installed" : "-> npm install failed:\n" + res.output.slice(-800),
  });
  return res.ok;
}

/** The real gate: next build. Returns the log tail.

   ALWAYS builds from a clean slate (rm -rf .next first). An incremental
   `.next` is a trap here: a failed round compiles the broken tree into the
   cache, and once the coder has fixed the sources the next `next build`
   happily re-exports the STALE artifacts of that broken round and fails with
   errors that reference code the current sources do not even contain. The
   fix rounds then chase a ghost forever. */
async function build(runId: string): Promise<{ ok: boolean; output: string }> {
  const dir = workspaceDir(runId);
  try {
    rmSync(join(dir, ".next"), { recursive: true, force: true });
  } catch {
    /* if the cache is locked, the build below still gets a fair try */
  }
  await ensureRootPage(runId);
  const res = await sh("npx next build", dir, 420_000);
  const lines = res.output.split("\n").filter((l) => l.trim().length > 0);
  if (!res.ok) {
    const probe = await sh(envProbe(), dir, 30_000);
    lines.push("[build-env] " + probe.output.split("\n").filter(Boolean).join(" | "));
  }
  return { ok: res.ok, output: lines.slice(-40).join("\n") };
}

/* ------------------------------------------------------------------ *
 * Public API — the orchestrator's contract, unchanged
 * ------------------------------------------------------------------ */

export type CodeResult = {
  ok: boolean;
  files: string[];
  buildOk: boolean;
  workspacePath: string;
  error: string | null;
};

export async function writeScaffold(runId: string, master: MasterBuildPrompt): Promise<void> {
  const slug = master.productName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "product";
  writeFiles(runId, scaffold(master.productName, slug));
}

/** Drop any model-emitted file the platform owns (or that would corrupt the tree). */
function guardScaffold(files: WorkspaceFile[], emit: Emit): WorkspaceFile[] {
  const kept = files.filter((f) => writePathAllowed(f.path));
  for (const f of files) {
    if (!writePathAllowed(f.path)) {
      const why = isRootRouteHandler(f.path)
        ? "would collide with app/page.tsx at / — one module per route path"
        : "platform-owned or unsafe path";
      void emit({ kind: "warn", line: `-> ignored model attempt to write ${f.path} (${why})` });
    }
  }
  return kept;
}

/** Remove route handlers the model may have created before the guard existed.
 *
 *  A run can be retried from a workspace written by an older build of this
 *  agent, and the deploy uploads whatever is on disk. A stale app/route.ts
 *  therefore poisons every later attempt with a route collision the model
 *  cannot see or delete, so the guard sweeps the workspace before each build
 *  gate instead of only policing new writes. */
function pruneRouteCollisions(runId: string, emit: Emit): void {
  for (const c of routeCollisions(runId)) {
    try {
      rmSync(join(workspaceDir(runId), c.path), { force: true });
      void emit({
        kind: "warn",
        line: `-> removed ${c.path} — it collides with ${c.owner} at the same route path`,
      });
    } catch {
      /* best effort: the build gate will report it if the file survives */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Pass 3 machinery: the plan + one file per request, in parts when big.
 * ------------------------------------------------------------------ */

type PlannedFile = { path: string; purpose: string };

const PART_LINES = 120; // comfortably under the gateway's truncation point
const MAX_PARTS = 8;

/** A continuation request: same file, next slice, given what we already have. */
function partPrompt(
  master: MasterBuildPrompt,
  target: PlannedFile,
  written: string[],
  upcoming: string[],
  importerLines: string[],
  soFar: string,
  part: number,
  /** modules that were planned but could NOT be produced — importing any of
      them guarantees an unresolvable-module build failure */
  unavailable: string[] = [],
  /** the real exported surface of the modules that already exist */
  contracts = "",
): string {
  const header =
    part === 1
      ? `Write "${target.path}" — purpose: ${target.purpose || "part of the product"}.`
      : `Continue "${target.path}". Here is part 1..${part - 1} of the file:\n\n${soFar}\n\nContinue EXACTLY where it stops — do not repeat any line, do not restart, do not re-add the imports.`;
  return `${master.instructions}

${STACK_LINE}

${header}

Already written and final (do not rewrite): ${written.join(", ") || "(none yet besides the shell)"}
Planned but not written yet (assume their exports exist at these paths): ${upcoming.join(", ") || "(none)"}
${
    unavailable.length > 0
      ? `DO NOT EXIST — every import of these FAILS TO BUILD. Never import them; implement the behaviour inline in this file instead:\n${unavailable.map((p) => "  " + p).join("\n")}\n`
      : ""
  }${
    contracts
      ? `\nModules that ALREADY EXIST, with their real exported surface. Use these names exactly as written — match the import style they show (default vs named), and never call a member that is not listed here:\n${contracts}`
      : ""
  }${
    importerLines.length > 0
      ? `\nExisting files import "${target.path}" with exactly these lines — honor the names and props they use:\n${importerLines.map((l) => "  " + l).join("\n")}`
      : ""
  }

Write about ${PART_LINES} lines for this part${part === 1 ? " (plus the imports)" : ""}. Rules: TypeScript strict, Tailwind v4, "use client" on top of interactive components, no placeholders, no npm deps beyond next/react. End the part on a complete statement.

Return ONLY valid JSON: {"path": "${target.path}", "content": "<this part>", "done": <true if the whole file is now complete, else false>}`;
}

/** The fallback ask: raw source, no JSON wrapper — and one SLICE of it.
    Asking a single response for a whole page is what the model cannot do,
    which is the entire reason the part mechanism exists. */
function rawPartPrompt(
  master: MasterBuildPrompt,
  target: PlannedFile,
  written: string[],
  unavailable: string[],
  contracts: string,
  part: number,
  soFar: string,
): string {
  const header =
    part === 1
      ? `Write the FIRST part of the file "${target.path}" — purpose: ${target.purpose || "part of the product"}.\nWrite about ${PART_LINES} lines and then STOP. Do not try to finish the whole file in one answer.`
      : `Continue the file "${target.path}". Everything written so far:\n\n${soFar}\n\nContinue from the exact next line — do not repeat anything, do not restart, do not re-add imports. Write about ${PART_LINES} more lines and then STOP.`;
  return `${master.instructions}

${STACK_LINE}

${header}

Already written and final (do not rewrite): ${written.join(", ") || "(none yet besides the shell)"}
${
    unavailable.length > 0
      ? `DO NOT EXIST and must never be imported: ${unavailable.join(", ")} — implement the behaviour inline instead.`
      : ""
  }
${
    contracts
      ? `\nModules that ALREADY EXIST — use their exported names exactly as written here:\n${contracts}\n`
      : ""
  }
Rules: TypeScript strict, Tailwind v4, "use client" on top of interactive components, no placeholders, no TODOs, no npm dependencies beyond next/react. End on a complete statement.

Respond with source code ONLY — no JSON, no markdown fence, no explanation before or after.`;
}

/** Parse one part: {"path","content","done"}, a files[] wrapper, or the key
    a free model felt like using instead of "content" — `code`, `source`,
    `file`... rejecting those threw away good files for no reason. */
function parsePart(text: string): { content: string; done: boolean } | null {
  const json = extractJson<unknown>(text);
  if (json == null) return null;
  // a bare JSON string is a legal (if unhelpful) shape: treat it as the file
  if (typeof json === "string") {
    return json.trim().length >= 20 ? { content: json, done: false } : null;
  }

  const arr = Array.isArray(json) ? (json as unknown[]) : null;
  const obj = (arr ? arr[0] : json) as Record<string, unknown> | undefined;
  if (!obj || typeof obj !== "object") return null;

  const src =
    typeof obj.content === "string" && obj.content.trim().length >= 20
      ? obj
      : (asObjectArray(obj.files, 4).find((f) => typeof f.content === "string") as Record<string, unknown> | undefined) ?? obj;

  const content = [src.content, src.code, src.file, src.source, src.text, src.body].find(
    (v): v is string => typeof v === "string" && v.trim().length >= 20,
  );
  if (!content) return null;

  const done =
    src.done === true || src.done === "true" || src.complete === true || src.finished === true || src.isComplete === true;
  return { content, done };
}

/** Write one file, in as many parts as the model needs. Never throws. */
async function writeFileByParts(
  plan: PlanId,
  master: MasterBuildPrompt,
  runId: string,
  target: PlannedFile,
  written: string[],
  upcoming: string[],
  emit: Emit,
  label?: string,
  /** planned-but-unproducible modules this file must not import */
  unavailable: string[] = [],
): Promise<WorkspaceFile | null> {
  const importerLines = importLinesFor(runId, target.path);
  // the real surface of everything already on disk — computed once, then
  // repeated in every part request so a continuation cannot drift from it
  const contracts = moduleContracts(runId, written, 8_000);
  const parts: string[] = [];
  let done = false;

  for (let part = 1; part <= MAX_PARTS && !done; part++) {
    const prompt = partPrompt(master, target, written, upcoming, importerLines, parts.join("\n"), part, unavailable, contracts);
    if (part > 1) await emit({ kind: "info", line: `-> ${label ?? target.path} part ${part} (${parts.join("\n").split("\n").length} lines so far)` });

    let got: { content: string; done: boolean } | null = null;
    let reason = "";
    for (let attempt = 0; attempt < 2 && !got; attempt++) {
      try {
        const text = await modelCall(
          plan,
          attempt === 0 ? prompt : prompt + "\n\nYour previous answer was not valid JSON. Return ONLY the JSON object, no prose, no fences.",
          9_000,
          200_000,
        );
        got = parsePart(text);
        if (!got) reason = "answer was not a usable {content} object";
      } catch (err) {
        reason = err instanceof Error ? err.message.replace(/\s+/g, " ").slice(0, 160) : String(err).slice(0, 160);
      }
    }

    /* Raw-source fallback. Embedding a whole source file inside a JSON string
       is where the model most often fails, and discarding the file costs the
       entire run (an unresolved import is unfixable downstream). Ask for one
       slice of plain code instead, with no JSON mode at all. */
    if (!got) {
      try {
        const raw = await modelCall(
          plan,
          rawPartPrompt(master, target, written, unavailable, contracts, part, parts.join("\n")),
          12_000,
          200_000,
          false,
        );
        const code = stripFences(raw ?? "");
        if (code.trim().length > 40) {
          await emit({ kind: "info", line: `-> ${target.path} part ${part} recovered from a raw (non-JSON) answer` });
          parts.push(code);
          done = looksComplete(parts.join("\n"));
          if (!done && part === MAX_PARTS) {
            await emit({ kind: "warn", line: `-> ${target.path} hit the ${MAX_PARTS}-part cap — the build gate will catch any truncation` });
          }
          continue;
        }
        reason = reason || "raw answer was empty";
      } catch (err) {
        reason = err instanceof Error ? err.message.replace(/\s+/g, " ").slice(0, 160) : String(err).slice(0, 160);
      }
    }

    if (!got) {
      await emit({
        kind: "warn",
        line: `-> ${target.path} part ${part} unusable${reason ? " (" + reason + ")" : ""} — stopping this file after ${parts.length} part(s)`,
      });
      break;
    }
    parts.push(got.content);
    done = got.done;
    if (!done && part === MAX_PARTS) {
      await emit({ kind: "warn", line: `-> ${target.path} hit the ${MAX_PARTS}-part cap — the build gate will catch any truncation` });
    }
  }

  if (parts.length === 0) return null;
  const content = parts.join("\n");
  return { path: target.path, content };
}

async function planFiles(plan: PlanId, master: MasterBuildPrompt, emit: Emit): Promise<PlannedFile[]> {
  const text = await modelCall(plan, filePlanPass(master), 2_000, 120_000);
  const json = extractJson<{ files?: unknown }>(text);
  if (!json) throw new Error("model returned no parseable file plan");
  const seen = new Set<string>(["app/globals.css", "app/layout.tsx", "app/page.tsx"]);
  const out: PlannedFile[] = [];
  for (const f of asObjectArray(json.files, 24)) {
    const p = asString(f.path).replace(/^\/+/, "");
    if (!p || p.length > 120 || !planPathAllowed(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({ path: p, purpose: asString(f.purpose).slice(0, 140) });
    if (out.length >= 10) break;
  }
  if (out.length === 0) {
    await emit({ kind: "warn", line: "-> plan listed no usable files — building with the shell only" });
    return [];
  }
  return out;
}

/** Import lines in already-written files that point at `targetPath`. */
function importLinesFor(runId: string, targetPath: string): string[] {
  const base = targetPath.replace(/\.(ts|tsx|js|jsx)$/, "").split("/").pop() ?? "";
  const targetNoExt = targetPath.replace(/\.(ts|tsx|js|jsx)$/, "");
  if (!base) return [];
  const hits: string[] = [];
  const dir = workspaceDir(runId);
  for (const rel of listFiles(runId)) {
    if (rel === targetPath || rel.endsWith("/")) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, rel), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = line.match(/from\s+"([^"]+)"/) ?? line.match(/import\s+"([^"]+)"/);
      if (!m) continue;
      const spec = m[1].replace(/^\.\//, "").replace(/^@\//, "").replace(/\.(ts|tsx|js|jsx)$/, "");
      if (spec === targetNoExt || spec.endsWith("/" + base)) hits.push(line.trim());
    }
    if (hits.length >= 3) break;
  }
  return hits.slice(0, 3);
}

/* ————————————————— file contracts —————————————————

   Each file is generated by its own request, so the page and the modules it
   uses were written by different answers: the caller invents `useGame().setMode`
   and a default-export Board while the module actually exports a named Board
   and a hook with no setMode. The result is a tree that has every file and
   still cannot typecheck.

   So every prompt is given the ACTUAL exported surface of the modules that
   already exist. Exports are extracted from the real source on disk, which
   makes the contract the caller codes against something the model cannot
   misremember. */

/** Declaration lines that define a module's public surface. Interface and type
    bodies are kept verbatim — member names are exactly what callers get wrong. */
function exportedSurface(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("export")) continue;

    // keep type/interface/enum bodies whole: these are the contracts
    if (/^export\s+(default\s+)?(interface|type|enum)\b/.test(line)) {
      const body: string[] = [];
      let depth = 0;
      let opened = false;
      for (let j = i; j < lines.length && body.length < 48; j++) {
        const l = lines[j];
        body.push(l.replace(/\s+$/, ""));
        for (const ch of l) {
          if (ch === "{") {
            depth++;
            opened = true;
          } else if (ch === "}") depth--;
        }
        if (opened) {
          if (depth <= 0) break;
        } else if (j > i) {
          // a one-line alias/signature (`export type Mode = "a" | "b";`)
          if (/[;]/.test(l) || j > i + 5) break;
        }
      }
      i += body.length - 1;
      out.push(body.join("\n").trim());
      continue;
    }

    out.push(line.length > 220 ? line.slice(0, 220) + " …" : line);
  }
  return out.join("\n");
}

/** The exported surface of the given files, size-capped for prompt safety. */
function moduleContracts(runId: string, paths: string[], budget = 9_000): string {
  const parts: string[] = [];
  let used = 0;
  for (const p of paths) {
    if (!/\.(ts|tsx)$/.test(p)) continue;
    if (/^(app\/page|app\/layout|app\/globals)/.test(p)) continue; // the caller itself
    const src = readWorkspaceFile(runId, p);
    if (!src) continue;
    const surface = exportedSurface(src);
    if (!surface.trim()) continue;
    const chunk = `--- ${p} exports ---\n${surface}\n`;
    if (used + chunk.length > budget) break;
    parts.push(chunk);
    used += chunk.length;
  }
  return parts.join("\n");
}

/* ------------------------------------------------------------------ *
 * Generation: the four passes
 * ------------------------------------------------------------------ */

/** Run a batched generation request with a retry ladder.
 *  `ask` is re-invoked for each attempt, so a fumbled response is actually
 *  re-requested (with a sterner instruction) instead of re-parsed. */
async function modelFiles(ask: (retry: boolean) => Promise<string>, emit: Emit, label: string): Promise<WorkspaceFile[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await ask(attempt === 1);
    try {
      return parseFiles(text);
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 120) : String(err);
      if (attempt === 0) {
        await emit({ kind: "warn", line: `-> ${label} came back unusable (${message}) — re-requesting` });
      } else {
        throw new Error(message);
      }
    }
  }
  throw new Error("model returned no parseable file list");
}

export async function generateCodebase(
  runId: string,
  master: MasterBuildPrompt,
  plan: PlanId,
  emit: Emit,
): Promise<CodeResult> {
  await emit({ kind: "command", line: `$ lastmile code — "${master.productName.toLowerCase()}"` });

  try {
    /* a retry must start from a clean tree: stale files from a crashed
       attempt otherwise haunt every later build + patch round */
    resetWorkspaceSources(runId);
    /* the scaffold is written here too: retries must always start from a
       coherent build target */
    writeScaffold(runId, master);

    /* pass 1 — the static shell (two small, related files) */
    await emit({ kind: "info", line: "-> pass 1/4 — app shell (globals.css, layout.tsx)" });
    const shell = await modelFiles(
      async (retry) =>
        modelCall(
          plan,
          shellStaticPass(master) + (retry ? "\n\nYour previous answer was not valid JSON. Return ONLY the JSON object, no prose, no fences." : ""),
          8_000,
          180_000,
        ),
      emit,
      "pass 1 (app shell)",
    );
    await writeAndAnnounce(runId, shell, emit);

    /* pass 2 — the plan. BEFORE the page, so the page can only import
       files that are guaranteed to be written afterwards. */
    await emit({ kind: "info", line: "-> pass 2/4 — planning the file layout" });
    let planned: PlannedFile[] = [];
    try {
      planned = await planFiles(plan, master, emit);
    } catch (err) {
      await emit({
        kind: "warn",
        line: "-> file plan unavailable (" + (err instanceof Error ? err.message.slice(0, 120) : String(err)).slice(0, 120) + ") — continuing with the shell only",
      });
    }
    if (planned.length > 0) {
      await emit({ kind: "info", line: `-> planned ${planned.length} file${planned.length === 1 ? "" : "s"} — one request each` });
    }

    /* pass 3 — every planned module, BEFORE the page that imports them.
       Order matters more than anything else here: the page is the most
       import-heavy file in the app, so it has to be generated last, when the
       modules it depends on either exist on disk or are known to be missing.
       Generating it first (the old order) meant one failed component left the
       page importing a file that was never written — an unresolvable module,
       which no amount of patching can fix. */
    const written: string[] = shell.map((f) => f.path);
    const missing: string[] = [];
    if (planned.length > 0) {
      await emit({ kind: "info", line: "-> pass 3/4 — modules the page will use" });
      let okCount = 0;
      for (let i = 0; i < planned.length; i++) {
        const target = planned[i];
        await emit({ kind: "info", line: `-> [${i + 1}/${planned.length}] writing ${target.path}` });
        const f = await writeFileByParts(plan, master, runId, target, written, planned.slice(i + 1).map((p) => p.path), emit);
        if (f) {
          writeFiles(runId, [f]);
          written.push(f.path);
          await emit({ kind: "success", line: `-> wrote ${f.path}` });
          okCount++;
        } else {
          missing.push(target.path);
          await emit({ kind: "warn", line: `-> could not produce ${target.path} — the page will be told not to import it` });
        }
      }
      await emit({ kind: "info", line: `-> ${okCount}/${planned.length} planned files written` });
      if (missing.length > 0) {
        await emit({
          kind: "warn",
          line: `-> ${missing.length} module${missing.length === 1 ? "" : "s"} could not be generated: ${missing.join(", ")} — the main page must implement that behaviour inline`,
        });
      }
    }

    /* pass 4 — the main page, told exactly which modules exist and which do
       not, so it can never produce an unresolvable import. */
    await emit({ kind: "info", line: "-> pass 4/4 — main page (app/page.tsx)" });
    const pageFile = await writeFileByParts(
      plan,
      master,
      runId,
      { path: "app/page.tsx", purpose: `the main page "${master.pages[0]?.path ?? "/"}" — full structure, final import + prop contracts` },
      written,
      [],
      emit,
      "app/page.tsx",
      missing,
    );
    if (pageFile) {
      await writeAndAnnounce(runId, [pageFile], emit);
    } else {
      await emit({ kind: "error", line: "-> could not produce app/page.tsx — the run cannot continue without the main page" });
      return { ok: false, files: [], buildOk: false, workspacePath: workspaceDir(runId), error: "main page could not be generated" };
    }

    await emit({ kind: "info", line: `-> ${fileCount(runId)} files in the workspace` });
    return finish(runId, master, plan, emit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emit({ kind: "error", line: "-> code generation failed - " + message.slice(0, 300) });
    return { ok: false, files: [], buildOk: false, workspacePath: workspaceDir(runId), error: message };
  }
}

/* ------------------------------------------------------------------ *
 * The gate: install → typecheck → build → fix rounds
 * ------------------------------------------------------------------ */

/** Install deps + build + fix loop. Shared by first generation and patches.
 *  The gate is tsc --noEmit FIRST (reports ALL type errors at once), then
 *  next build — otherwise next build stops at the first type error and each
 *  fix round only reveals the next one. */
export async function finish(
  runId: string,
  master: MasterBuildPrompt,
  plan: PlanId,
  emit: Emit,
  fixRounds = 3,
): Promise<CodeResult> {
  const dir = workspaceDir(runId);
  if (!(await ensureDeps(runId, emit))) {
    return { ok: false, files: [], buildOk: false, workspacePath: dir, error: "npm install failed" };
  }

  for (let round = 0; round <= fixRounds; round++) {
    pruneRouteCollisions(runId, emit);
    await emit({ kind: "command", line: "$ npx tsc --noEmit && npx next build" });
    const types = await typecheck(runId);
    if (!types.ok) {
      if (round === fixRounds) {
        await emit({ kind: "error", line: "-> type errors still present after " + fixRounds + " fix rounds:\n" + types.output.slice(-900) });
        return { ok: false, files: listAll(runId), buildOk: false, workspacePath: dir, error: "type errors after fix rounds: " + errorDigest(types.output, 2) };
      }
      await emit({
        kind: "warn",
        line:
          "-> " + types.errors + " type error" + (types.errors === 1 ? "" : "s") +
          " — sending them ALL back to the coder (round " + (round + 1) + ")\n" + errorDigest(types.output),
      });
      const ok = await patchBuild(runId, master, plan, types.output, emit);
      if (!ok) {
        return { ok: false, files: listAll(runId), buildOk: false, workspacePath: dir, error: "model could not patch the type errors: " + errorDigest(types.output, 2) };
      }
      continue;
    }
    const result = await build(runId);
    if (result.ok) {
      await emit({ kind: "success", line: "-> production build passed" });
      return { ok: true, files: listAll(runId), buildOk: true, workspacePath: dir, error: null };
    }
    if (round === fixRounds) {
      await emit({ kind: "error", line: "-> build still failing after " + fixRounds + " fix rounds:\n" + result.output.slice(-900) });
      return { ok: false, files: listAll(runId), buildOk: false, workspacePath: dir, error: "build failed after fix rounds: " + errorDigest(result.output, 2) };
    }
    await emit({
      kind: "warn",
      line: "-> build failed — sending the errors back to the coder (round " + (round + 1) + ")\n" + errorDigest(result.output),
    });
    const ok = await patchBuild(runId, master, plan, result.output, emit);
    if (!ok) {
      return { ok: false, files: listAll(runId), buildOk: false, workspacePath: dir, error: "model could not patch the build errors: " + errorDigest(result.output, 2) };
    }
  }
  return { ok: false, files: listAll(runId), buildOk: false, workspacePath: dir, error: "unreachable" };
}

/** A site with no page at "/" builds and deploys perfectly and then serves a
 *  404 at its own root — every gate in this pipeline passes, because Next is
 *  happy and the build is green. It happened once (the coder resolved a route
 *  collision by deleting app/page.tsx and moving the greeting to /hello) and
 *  nothing caught it until the live QA stage. This is the last line of
 *  defence: if the page component is missing, restore it before the build so
 *  the failure is impossible to ship, not merely unlikely. */
export function ensureRootPage(runId: string): boolean {
  const dir = workspaceDir(runId);
  if (PAGE_ROUTES.some((p) => existsSync(join(dir, p)))) return true;
  const content = `export default function HomePage(): React.ReactElement {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-4xl font-semibold tracking-tight">Welcome</h1>
    </main>
  );
}
`;
  try {
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "page.tsx"), content, "utf8");
    return false;
  } catch {
    return false;
  }
}

/** Full-project typecheck. Unlike next build, it reports every error at once.
 *
 *  `.next/types/validator.ts` must go first. Next generates it from the file
 *  tree on every build, and tsconfig includes it — so after a fix round that
 *  DELETES a route (the only way out of a route collision) the stale mirror
 *  still imports the removed module and tsc reports
 *  "Cannot find module '../../app/route.js'" for a file that no longer exists.
 *  The model cannot fix that by writing anything, and the fix rounds stall on
 *  a phantom import. Clearing the generated types makes the typecheck describe
 *  the sources that are actually on disk. */
async function typecheck(runId: string): Promise<{ ok: boolean; output: string; errors: number }> {
  const dir = workspaceDir(runId);
  try {
    rmSync(join(dir, ".next", "types"), { recursive: true, force: true });
  } catch {
    /* a locked cache still gets a fair try below */
  }
  const res = await sh("npx tsc --noEmit", dir, 300_000);
  const lines = res.output.split("\n").filter((l) => l.trim().length > 0);
  const errors = lines.filter((l) => /error TS\d+/.test(l)).length;
  return { ok: res.ok, output: lines.slice(-40).join("\n"), errors: errors || (res.ok ? 0 : 1) };
}

/** The few lines of a compiler/build log that actually say what went wrong.
    Without this the dashboard showed "build failed" and nothing else, which
    made the failure impossible to diagnose from the run page. */
function errorDigest(output: string, max = 4): string {
  const lines = output
    .split("\n")
    .map((l) => l.replace(/^\s+/, "").trim())
    .filter(Boolean);
  const hits = lines.filter((l) =>
    /error TS\d+|Type error|Cannot find module|Module not found|Failed to compile|Error:|Failed to build/i.test(l),
  );
  return (hits.length > 0 ? hits : lines).slice(0, max).join("\n").slice(0, 700);
}

/** Module specifiers the log says are imported but cannot be resolved.
 *  These are the most common reason a generated app will not build, and the
 *  fix is always the same: the file has to be CREATED. Only local/aliased
 *  specifiers count — a bare package name is an install problem, not a file. */
function missingModules(log: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /Cannot find module '([^']+)'/g,
    /Cannot find module "([^"]+)"/g,
    /Module not found: Can't resolve '([^']+)'/g,
    /Module not found: Can't resolve "([^"]+)"/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(log)) !== null) {
      const spec = m[1].trim();
      if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("@/")) out.add(spec);
    }
  }
  return [...out].slice(0, 10);
}

/** Files in the workspace that would collide with a scaffold page at the same
    URL. Next's rule is one module per path, so every entry is a hard build
    error the model must resolve by deleting. */
function routeCollisions(runId: string): { path: string; owner: string }[] {
  const present = new Set(listAll(runId));
  const out: { path: string; owner: string }[] = [];
  for (const page of PAGE_ROUTES) {
    if (!present.has(page)) continue;
    const dir = page.slice(0, page.lastIndexOf("/") + 1);
    for (const name of ["route.ts", "route.tsx", "route.js", "route.jsx"]) {
      if (present.has(dir + name)) out.push({ path: dir + name, owner: page });
    }
  }
  return out;
}

/** Pull workspace file paths that the build log explicitly references. */
function filesFromLog(runId: string, log: string): string[] {
  const known = listAll(runId);
  const hits = new Set<string>();
  for (const rel of known) {
    const base = rel.split("/").pop() ?? rel;
    if (log.includes(rel) || (base.length > 4 && log.includes(base))) hits.add(rel);
  }
  return [...hits];
}

/** Repair a build failure from raw compiler output.

    The same loop serves both gates: the local one passes its captured stdout,
    and the deploy stage passes the remote builder's log fetched from the
    hosting provider. A remote failure is just a build failure whose log we had
    to go and collect — the fix is identical. */
export async function patchBuildErrors(runId: string, master: MasterBuildPrompt, plan: PlanId, buildLog: string, emit: Emit): Promise<boolean> {
  return patchBuild(runId, master, plan, buildLog, emit);
}

async function patchBuild(runId: string, master: MasterBuildPrompt, plan: PlanId, buildLog: string, emit: Emit): Promise<boolean> {
  const current = listAll(runId);
  const named = filesFromLog(runId, buildLog);

  /* Being able to CREATE a missing file is what makes this loop able to
     recover at all. "Cannot find module '@/components/Board'" was the single
     most common failure, and the old prompt only showed files that already
     existed — so the model had no idea it had to write the missing one. */
  const missing = missingModules(buildLog);
  const missingBlock =
    missing.length > 0
      ? `\n\nMISSING MODULES — imported by existing files but the files DO NOT EXIST. The build cannot pass until you CREATE them, so each one must appear in "files" as a complete new file:\n${missing.map((m) => "  - " + m).join("\n")}`
      : "";

  /* Two files owning one route path is a structural failure no amount of
     rewriting can fix — the model has to be able to remove one. Reporting
     the collision explicitly (with the remedy) is what turns three wasted
     rounds into a single decisive patch. */
  const collisions = routeCollisions(runId);
  const collisionBlock =
    collisions.length > 0
      ? `\n\nROUTE COLLISION — Next.js allows exactly ONE module per route path, so these are a hard build error ("You cannot have two parallel pages that resolve to the same path"):\n${collisions.map((c) => `  - "${c.path}" resolves to the same URL as "${c.owner}"`).join("\n")}\n  HOW TO RESOLVE IT: delete the route handler with "delete": ["${collisions[0].path}"] and put the behaviour it provided INSIDE ${collisions[0].owner}. ${collisions[0].owner} must never be deleted or renamed — it is the ONLY module that serves "/", and deleting it makes the site return 404 at its own root. Never move the root page to another path like app/hello/page.tsx: the product's home page has to live at "/".`
      : "";

  /* Cross-file contract drift is why a fix round can lower the error count and
     still not converge: rewriting one module changes what its callers may use.
     Showing the whole tree's exported surface lets the model keep every caller
     compiling while it fixes the file it was asked to change. */
  const contracts = moduleContracts(runId, current, 8_000);
  const contractBlock = contracts
    ? `\n\nEXPORTED SURFACES of the existing files. A file you rewrite must keep (or extend) the names listed for it — other files already call them:\n${contracts}`
    : "";

  const full = `${master.instructions}\n\n${STACK_LINE}\n\nThe Next.js build failed with these errors:\n\n${buildLog.slice(-3500)}${missingBlock}${collisionBlock}\n\nExisting files: ${current.join(", ")}${named.length > 0 ? `\n\nThe errors reference: ${named.join(", ")}` : ""}${contractBlock}\n\nCurrent source of the relevant files:\n${snapshotFiles(runId, named)}\n\nFix the build at the root cause. Return ONLY the files that must change OR be created (full new content, not diffs), plus any file that must stop existing: {"files": [{"path": "...", "content": "..."}], "delete": ["path/to/remove"]}`;
  const minimal = `Fix these build errors:\n\n${buildLog.slice(-2500)}${missingBlock}${collisionBlock}${contractBlock}\n\nRespond with ONLY valid JSON, no prose: {"files": [{"path": "<file to change or create>", "content": "<complete new file content>"}], "delete": ["<path that must be removed>"]}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const prompt = attempt === 0 ? full : minimal;
      const text = await modelCall(plan, prompt, attempt === 0 ? 12_000 : 10_000, 240_000);
      const removed = await applyDeletes(runId, parseDeletes(text), emit);
      const files = guardScaffold(parseFiles(text), emit);
      if (files.length === 0) {
        // a deletion-only answer is a legitimate, complete repair
        if (removed > 0) return true;
        throw new Error("the answer contained no writable files (only platform-owned paths, or no file objects)");
      }
      writeFiles(runId, files);
      for (const f of files) await emit({ kind: "info", line: `-> patched ${f.path}` });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 140) : String(err).slice(0, 140);
      if (attempt < 2) {
        await emit({ kind: "warn", line: `-> patch response unusable (${message}) — retrying with a ${attempt === 0 ? "minimal" : "terser"} ask` });
      } else {
        await emit({ kind: "error", line: "-> patch request failed - " + message });
      }
    }
  }
  return false;
}

/** The quality loop's fix phase: patch the workspace for concrete defects. */
export async function patchForIssues(
  runId: string,
  master: MasterBuildPrompt,
  plan: PlanId,
  issues: { title: string; detail: string | null; severity: string; source: string }[],
  emit: Emit,
): Promise<boolean> {
  await emit({ kind: "command", line: `$ lastmile fix — ${issues.length} defect${issues.length === 1 ? "" : "s"} from QA` });
  const issueBlock = issues
    .map((i) => `- [${i.severity}/${i.source}] ${i.title}${i.detail ? "\n    " + i.detail.slice(0, 400).replace(/\n/g, "\n    ") : ""}`)
    .join("\n");
  try {
    const text = await modelCall(plan, patchPass(master, issueBlock, listAll(runId), snapshotFiles(runId, null)), 14_000, 240_000);
    const removed = await applyDeletes(runId, parseDeletes(text), emit);
    const files = guardScaffold(parseFiles(text), emit);
    if (files.length === 0) return removed > 0;
    writeFiles(runId, files);
    for (const f of files) await emit({ kind: "info", line: `-> fixed ${f.path}` });
    return true;
  } catch (err) {
    await emit({ kind: "error", line: "-> fix request failed - " + (err instanceof Error ? err.message.slice(0, 200) : String(err)) });
    return false;
  }
}

function listAll(runId: string): string[] {
  return listFiles(runId).filter((f) => !f.endsWith("/"));
}

export function joinWorkspace(runId: string, rel: string): string {
  return join(workspaceDir(runId), rel);
}
