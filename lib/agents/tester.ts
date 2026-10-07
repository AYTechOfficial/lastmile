/* The Live QA stage — the last gate before a link is called verified.

   What it actually does, in honest order:

     1. Decides whose browser drives the checks: the cloud browser for Pro
        (its live view is recorded so the run page can show it), headless
        checks on the runner for free. A Pro run without a cloud key falls
        back rather than failing — see lib/ai/browser.

     2. Mechanically hits the deployed URL and every route the spec promised,
        and records what came back: status codes, response time, whether the
        page contains something a human would recognise as the product rather
        than an error slate. These checks are deterministic and run first,
        because they are the ones that never lie.

     3. Asks the model to review the REAL rendered HTML of the main page
        against the acceptance criteria — the only check that can say "the
        page loads but the form the spec demanded is not on it". Findings go
        to the defect ledger with severities; `blocking > 0` sends the run
        back to the coder for a fix round.

   A test stage that cannot reach the URL fails the stage outright — unlike
   the model review, which degrades — because a link nobody can open is not a
   shipped product, whatever the model thinks of its HTML. */

import { chatJson, defaultModelFor, type ChatInput } from "../ai/chat";
import { planBrowser, createCloudSession } from "../ai/browser";
import type { ProductSpec } from "../domain";
import type { NewIssue } from "../pipeline/issues";
import type { PlanConfig } from "../plans";

export type TestInput = {
  plan: PlanConfig;
  userId: string;
  preferredModel: string | null;
  spec: ProductSpec | null;
  url: string | null;
  iteration: number;
  emit: (kind: "info" | "command" | "success" | "warn" | "error" | "url", line: string) => Promise<void>;
  heartbeat: () => Promise<void>;
};

export type TestResult = {
  ok: boolean;
  usable: boolean;
  issues: NewIssue[];
  score: number;
  report: {
    consoleErrors: string[];
    screenshotCount: number;
    flowsTotal: number;
    flowsPassed: number;
    assertions: number;
    score: number;
    browser: string;
  };
  tokens: number;
  reason?: string;
};

const PAGE_TIMEOUT_MS = 30_000;
const MAX_HTML_FOR_REVIEW = 24_000;

export async function runTester(input: TestInput): Promise<TestResult> {
  const started = Date.now();
  await input.emit("command", `$ lastmile test --iteration ${input.iteration}`);

  if (!input.url) {
    return {
      ok: false,
      usable: false,
      issues: [],
      score: 0,
      report: emptyReport("none"),
      tokens: 0,
      reason: "there is no live URL to test — the deploy stage never produced one",
    };
  }

  const base = input.url.replace(/\/+$/, "");
  const browser = await planBrowser(input.plan.id, input.userId);
  await input.emit("info", `-> ${browser.reason}`);

  let cloudLiveUrl: string | null = null;
  if (browser.mode === "cloud") {
    const { session, detail } = await createCloudSession(browser);
    if (session) {
      cloudLiveUrl = session.liveUrl;
      await input.emit("info", "-> cloud browser session open — its live view is on the run page");
    } else {
      await input.emit("warn", `-> cloud browser unavailable (${detail}) — falling back to runner checks`);
    }
  }

  /* ————— 1. the mechanical sweep ————— */

  const routes = ["/", ...(input.spec?.routes ?? []).map((r) => r.path).filter((p) => p !== "/")].slice(0, 8);
  const consoleErrors: string[] = [];
  let assertions = 0;
  let passed = 0;
  const routeResults: { path: string; status: number; ms: number; ok: boolean; note?: string }[] = [];

  for (const route of routes) {
    const t0 = Date.now();
    let status = 0;
    let html = "";
    let note: string | undefined;
    try {
      const res = await fetch(base + route, {
        headers: { "User-Agent": "LastMileQA/1.0 (+live-check)" },
        redirect: "follow",
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      status = res.status;
      html = await res.text();
      assertions += 1;
      if (res.ok && looksLikeAPage(html)) {
        passed += 1;
      } else {
        note = res.ok ? "response does not look like a rendered page" : `HTTP ${status}`;
      }
    } catch (error) {
      note = error instanceof Error ? error.message.slice(0, 120) : "request failed";
    }
    const ms = Date.now() - t0;
    routeResults.push({ path: route, status, ms, ok: !note, note });
    assertions += 1;
    if (note) consoleErrors.push(`${route}: ${note}`);
    await input.emit(
      note ? "warn" : "success",
      `  ${route} → ${status || "no response"} in ${ms}ms${note ? ` — ${note}` : ""}`,
    );
    await input.heartbeat();
  }

  const root = routeResults.find((r) => r.path === "/");
  if (!root || !root.ok) {
    return {
      ok: true,
      usable: false,
      issues: [
        {
          title: "the deployed site does not serve a working page at /",
          detail: root?.note ?? "the main route did not answer with a page",
          severity: "critical",
          files: [],
        },
      ],
      score: 0,
      report: {
        ...emptyReport(browser.label),
        consoleErrors,
        assertions,
        flowsPassed: passed,
        flowsTotal: routeResults.length,
      },
      tokens: 0,
      reason: "the live URL is not serving the product",
    };
  }

  /* ————— 2. the model review of the real page ————— */

  const rootHtml = await fetchText(base + "/");
  const issues: NewIssue[] = [];
  let modelScore: number | null = null;
  let tokens = 0;

  if (rootHtml) {
    const chatInput: ChatInput = {
      tier: input.plan.modelTier,
      userId: input.userId,
      agent: "test",
      preferred: input.preferredModel ?? defaultModelFor(input.plan.modelTier),
      timeoutMs: 120_000,
      maxRungs: 4,
      onAttempt: async (attempt) => {
        if (attempt.ok) {
          await input.emit(
            "success",
            `  model ${attempt.provider}/${attempt.model} reviewed the live page in ${Math.round(attempt.ms / 1000)}s`,
          );
        }
      },
    };

    const flows = input.spec?.flows ?? [];
    const review = await chatJson<{ issues?: { title?: string; detail?: string; severity?: string }[]; score?: number; flowsPassed?: string[] }>(
      chatInput,
      [
        {
          role: "system",
          content:
            "You are testing a DEPLOYED web app against its acceptance criteria. You get the rendered HTML of the main page and the flows the product promised. A flow passes only if the HTML clearly contains what the criterion needs (a form, a list, a control, real content). Report real, visible defects only. Reply with ONLY JSON: {\"issues\": [{\"title\", \"detail\", \"severity\": \"critical\"|\"major\"|\"minor\"}], \"score\": 0-100, \"flowsPassed\": [\"flow name\"]}.",
        },
        {
          role: "user",
          content: [
            `LIVE URL: ${base}`,
            flows.length > 0
              ? `FLOWS TO JUDGE:\n${flows.map((f) => `- ${f.name}: ${f.criteria.join("; ")}`).join("\n")}`
              : "FLOWS: unavailable — judge whether the page is a real product page",
            `RENDERED HTML:\n${rootHtml.slice(0, MAX_HTML_FOR_REVIEW)}`,
          ].join("\n\n"),
        },
      ],
    );
    tokens = review.result.tokens;

    if (review.value) {
      if (typeof review.value.score === "number") {
        modelScore = Math.max(0, Math.min(100, Math.round(review.value.score)));
      }
      const passedFlows = Array.isArray(review.value.flowsPassed) ? review.value.flowsPassed.length : 0;
      for (const i of (review.value.issues ?? []).slice(0, 10)) {
        const title = (i.title ?? "").trim();
        if (!title) continue;
        const severity = i.severity === "critical" || i.severity === "minor" ? i.severity : "major";
        issues.push({ title, detail: (i.detail ?? "").trim() || null, severity, files: [] });
      }
      await input.emit(
        "info",
        `-> live review: ${passedFlows}/${flows.length} flow(s) judged passing, ${issues.length} concern(s)`,
      );
    } else {
      await input.emit("warn", "-> model review of the live page unavailable — mechanical results stand alone");
    }
  }

  /* ————— 3. the score and the report ————— */

  const mechanicalScore = routeResults.length > 0
    ? Math.round((passed / routeResults.length) * 100)
    : 0;
  const score =
    modelScore === null
      ? mechanicalScore
      : Math.round(0.5 * mechanicalScore + 0.5 * modelScore);

  const blocking = issues.filter((i) => i.severity !== "minor").length;
  await input.emit(
    blocking > 0 ? "warn" : "success",
    `-> test finished in ${Math.round((Date.now() - started) / 1000)}s · ${passed}/${routeResults.length} route(s) up · score ${score}/100${cloudLiveUrl ? " · cloud session recorded" : ""}`,
  );

  return {
    ok: true,
    usable: true,
    issues,
    score,
    report: {
      consoleErrors,
      screenshotCount: cloudLiveUrl ? 1 : 0,
      flowsTotal: (input.spec?.flows ?? []).length || routeResults.length,
      flowsPassed: Math.max(passed, 0),
      assertions,
      score,
      browser: browser.label,
    },
    tokens,
  };
}

/* ————— helpers ————— */

/** A page, not an error slate: has markup, some text, and is not a bare
    "Internal Server Error" stub. */
function looksLikeAPage(html: string): boolean {
  if (html.length < 200) return false;
  if (!/<html|<body|<div|<main|<head/i.test(html)) return false;
  if (/^\s*(internal server error|service unavailable|not found)\s*$/i.test(html.trim())) return false;
  return true;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "LastMileQA/1.0 (+live-check)" },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function emptyReport(browser: string): TestResult["report"] {
  return {
    consoleErrors: [],
    screenshotCount: 0,
    flowsTotal: 0,
    flowsPassed: 0,
    assertions: 0,
    score: 0,
    browser,
  };
}
