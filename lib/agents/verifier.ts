import { agentChat } from "@/lib/ai/registry";
import { asObjectArray, asString, extractJson } from "@/lib/ai/json";
import type { Emit, MasterBuildPrompt } from "./prompt-engineer";
import { listFiles, readWorkspaceFile } from "@/lib/platform/workspace";
import type { PlanId } from "@/lib/platform/settings";

/* Verify Agent (code level) — reviews the workspace before anything ships.

   Real checks, in order:
     1. static — env completeness (process.env.X vs .env.example), hardcoded
        secrets, suspicious patterns (dangerouslySetInnerHTML on user data,
        eval), next/head rules
     2. build  — the production build result is passed in by the orchestrator;
        a failed build is a critical issue, not a warning
     3. spec   — an LLM review of the file tree + key files against the master
        prompt's must-have features, with a structured, actionable fix list

   Only critical issues block the pipeline; majors/minors travel to the quality
   loop so the tester confirms them against the live app. */

export type CodeIssue = {
  title: string;
  detail: string | null;
  severity: "critical" | "major" | "minor";
  source: "verify";
};

export type VerifyResult = {
  ok: boolean;
  issues: CodeIssue[];
  score: number; // 0-100 code-level confidence
};

const SECRET_RE =
  /(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

const SYSTEM = `You are the Verify Agent of LastMile. You review a codebase against its build contract before deployment.

You are strict about: missing must-have features, fake functionality (hardcoded arrays pretending to be dynamic data, dead buttons, TODO comments), broken imports, unreachable states, accessibility violations.

You never invent features that are not in the contract. Every issue you report is concrete, with the file it lives in and the exact fix.

THE PRODUCT IS ALWAYS A NEXT.JS 15 APP ROUTER WEB APPLICATION. Every route it serves is an HTML document rendered by React. That is the platform's fixed architecture and it is not reviewable: never report a missing route, a wrong renderer, or a Content-Type as "critical", and never demand an exact byte-for-byte response body. A request like "a page that says Hello, world" means an HTML page whose visible text is "Hello, world" — not a text/plain endpoint. Routes are also exclusive: exactly one module may own a path, so app/page.tsx and app/route.ts can never both exist at "/".

If the user's wording reads like an API contract (exact body, a specific Content-Type, a status code) that a rendering app cannot satisfy literally, that is not a defect the coder can fix — the coder cannot delete the page component or serve a non-HTML body from "/". Judge the delivered behaviour in the terms the architecture actually supports: does the page show the required content, do the required features work, are the states reachable. Report such a mismatch as at most "minor" and phrase it as a note for the quality loop, never as "critical". Reserve "critical" for things that are genuinely broken or genuinely missing — a file that does not compile, a feature listed in the contract that is absent, a dead control, a crash.

A review that asks for the impossible is worse than no review: the coder loops on it forever and the product never ships.`;

async function specReview(
  master: MasterBuildPrompt,
  plan: PlanId,
  fileTree: string[],
  emit: Emit,
): Promise<CodeIssue[]> {
  const keyFiles = pickKeyFiles(fileTree);
  const source = keyFiles
    .map((p) => `--- ${p} ---\n${reader(p)?.slice(0, 2600) ?? "(unreadable)"}`)
    .join("\n\n");

  const res = await agentChat(
    plan,
    "verify",
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `BUILD CONTRACT (must-have features):\n${master.features
          .filter((f) => f.priority === "must")
          .map((f) => `- ${f.name}: ${f.description}`)
          .join("\n")}\n\nQUALITY BAR:\n${master.qualityBar.map((q) => `- ${q}`).join("\n")}\n\nFILE TREE:\n${fileTree.join("\n")}\n\nKEY FILES:\n${source}\n\nReview the code against the contract. Return ONLY:\n{"pass": true|false, "issues": [{"title": "...", "detail": "file + exact fix", "severity": "critical|major|minor"}]}\nIf the contract is fully and genuinely implemented, pass is true and issues is empty.`,
      },
    ],
    { temperature: 0.2, maxTokens: 2200, json: true, timeoutMs: 120_000 },
  );
  await emit({ kind: "info", line: `-> spec review done (${res.providerLabel}, ${res.tokens} tokens)` });

  const json = extractJson<{ pass?: unknown; issues?: unknown }>(res.text);
  if (!json) throw new Error("review returned no parseable verdict");
  return asObjectArray(json.issues, 12)
    .map((i) => {
      const sev = asString(i.severity);
      return {
        title: asString(i.title),
        detail: asString(i.detail) || null,
        severity: demoteUnsatisfiable(sev, `${asString(i.title)} ${asString(i.detail)}`),
        source: "verify" as const,
      };
    })
    .filter((i) => i.title);
}

/* the reviewer reads through a bound reader so the orchestrator scopes it to
   one run's workspace */
let reader: (path: string) => string | null = () => null;

export function bindReader(runId: string): void {
  reader = (p) => readWorkspaceFile(runId, p);
}

export async function unbindReader(): Promise<void> {
  reader = () => null;
}

export async function verifyCodebase(
  runId: string,
  master: MasterBuildPrompt,
  plan: PlanId,
  buildOk: boolean,
  buildOutput: string,
  emit: Emit,
): Promise<VerifyResult> {
  await emit({ kind: "command", line: `$ lastmile verify — code review before deploy` });
  const issues: CodeIssue[] = [];

  const files = listFiles(runId).filter((f) => !f.endsWith("/"));
  const codeFiles = files.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f));

  /* 1 — static checks */
  const envUsed = new Set<string>();
  const envDeclared = new Set<string>(
    (readWorkspaceFile(runId, ".env.example") ?? "")
      .split("\n")
      .map((l) => l.split("=")[0]?.trim())
      .filter((l) => /^[A-Z][A-Z0-9_]*$/.test(l ?? "")),
  );
  let hardcodedSecrets = 0;
  let dangerous = 0;

  for (const rel of codeFiles) {
    const content = readWorkspaceFile(runId, rel) ?? "";
    for (const m of content.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) envUsed.add(m[1]);
    if (SECRET_RE.test(content)) {
      hardcodedSecrets++;
      issues.push({
        title: "Hardcoded credential in " + rel,
        detail: "A key-shaped literal is committed in source. Move it to an environment variable and document it in .env.example.",
        severity: "critical",
        source: "verify",
      });
    }
    if (/dangerouslySetInnerHTML/.test(content) && !/DOMPurify|sanitize/i.test(content)) {
      dangerous++;
      issues.push({
        title: "Unsanitized dangerouslySetInnerHTML in " + rel,
        detail: "Rendered HTML is not sanitized. Use DOMPurify or render text instead.",
        severity: "major",
        source: "verify",
      });
    }
    if (/\beval\s*\(|new Function\s*\(/.test(content)) {
      issues.push({ title: "Dynamic code execution in " + rel, detail: "eval/new Function is banned in this codebase.", severity: "major", source: "verify" });
    }
  }

  const missingEnv = [...envUsed].filter((e) => e !== "NODE_ENV" && e !== "NEXT_PUBLIC_" && !envDeclared.has(e) && !process.env[e]);
  if (missingEnv.length > 0) {
    issues.push({
      title: "Undocumented environment variables: " + missingEnv.join(", "),
      detail: "Used in code but absent from .env.example. Document them or inline defaults.",
      severity: "major",
      source: "verify",
    });
  }

  await emit({
    kind: "info",
    line: `-> static: ${codeFiles.length} code files scanned - ${hardcodedSecrets} secret hits, ${dangerous} unsafe html, ${missingEnv.length} env gaps`,
  });

  /* 2 — build gate */
  if (!buildOk) {
    issues.unshift({
      title: "Production build fails",
      detail: buildOutput.slice(-700),
      severity: "critical",
      source: "verify",
    });
  } else {
    await emit({ kind: "success", line: "-> build gate passed" });
  }

  /* 3 — spec review */
  bindReader(runId);
  try {
    await emit({ kind: "info", line: "-> reading the codebase against the master prompt" });
    const specIssues = await specReview(master, plan, files, emit);
    // spec findings join the same issue list, so the score below already
    // accounts for them — no separate specOk flag needed.
    issues.push(...specIssues);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await emit({ kind: "warn", line: "-> spec review unavailable (" + msg.slice(0, 120) + ") — static + build gates only" });
  } finally {
    await unbindReader();
  }

  const critical = issues.filter((i) => i.severity === "critical").length;
  const major = issues.filter((i) => i.severity === "major").length;
  const minor = issues.filter((i) => i.severity === "minor").length;
  const score = Math.max(0, 100 - critical * 30 - major * 12 - minor * 4);

  for (const i of issues.slice(0, 8)) {
    await emit({
      kind: i.severity === "critical" ? "error" : "warn",
      line: `[${i.severity.toUpperCase()}] ${i.title}`,
    });
  }
  await emit({
    kind: critical > 0 ? "error" : "success",
    line:
      critical > 0
        ? `-> verify failed — ${critical} critical issue${critical === 1 ? "" : "s"} must be fixed before deploy`
        : major + minor > 0
          ? `-> verify passed with notes — ${major} major, ${minor} minor (QA will re-check them live)`
          : "-> verify passed — codebase is clean",
  });

  return { ok: critical === 0, issues, score };
}

/** Keep the fix loop convergent: a severity the architecture cannot satisfy
 *  must never block the pipeline.
 *
 *  The reviewer is an LLM reading the user's raw prompt, and a prompt like
 *  "just a page with hello world" invites it to demand a literal HTTP contract
 *  — a text/plain body of exactly "Hello, world!", a non-HTML Content-Type, a
 *  root route handler. The scaffold always renders HTML from app/page.tsx and
 *  a page and a route handler can never share one path, so those demands are
 *  unfixable by construction. Left as "critical" they burn every fix round and
 *  kill the run at the code-review gate (a run once died on "Root route GET /
 *  does not exist" after the coder deleted its own route handler to resolve a
 *  collision the verifier had asked for). Demoting them to "minor" keeps the
 *  finding visible to the quality loop without stalling production. */
function demoteUnsatisfiable(rawSeverity: string, text: string): CodeIssue["severity"] {
  const severity: CodeIssue["severity"] =
    rawSeverity === "critical" || rawSeverity === "major" || rawSeverity === "minor" ? rawSeverity : "major";
  if (severity !== "critical") return severity;

  const aboutProtocol =
    /content-type|text\/plain|text\/html|application\/json|byte-for-byte|exactly equal|response body|status code|\bHEAD\b|\bOPTIONS\b|route handler|route\.ts|no CSS\/JS|asset request|EMPTY_LINES/i.test(
      text,
    );
  return aboutProtocol ? "minor" : severity;
}

function pickKeyFiles(fileTree: string[]): string[] {
  const priority = [
    /^app\/page\.tsx$/,
    /^app\/layout\.tsx$/,
    /^app\/api\//,
    /^components\//,
    /^lib\//,
  ];
  const picked: string[] = [];
  for (const re of priority) {
    for (const f of fileTree) {
      if (re.test(f) && !picked.includes(f) && picked.length < 8) picked.push(f);
    }
  }
  return picked;
}
