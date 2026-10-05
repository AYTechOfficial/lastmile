/* Browser Use — cloud browser agent (https://cloud.browser-use.com).

   The Testing Agent's live QA used to require a locally installed Chromium —
   on a box without Chrome/Edge the whole test stage hard-failed. When
   BROWSER_USE_API_KEY is present, each test flow runs as a cloud session
   instead: POST /api/v3/sessions with a natural-language task, poll until the
   agent stops, read `isTaskSuccessful` + `output`.

   The client is deliberately dependency-free (plain fetch) and throws on
   anything unexpected so the caller can fall back to local Playwright. */

const BASE =
  process.env.BROWSER_USE_BASE_URL?.trim().replace(/\/+$/, "") ||
  "https://api.browser-use.com/api/v3";

export function browserUseConfigured(): boolean {
  return Boolean(process.env.BROWSER_USE_API_KEY?.trim());
}

export type BrowserUseResult = {
  sessionId: string;
  /** the agent's own verdict on whether it accomplished the task */
  success: boolean;
  /** final agent output (its answer / report) */
  output: string;
  /** watch-the-agent live view URL */
  liveUrl: string | null;
  /** replay recording, when the platform has finished processing one */
  recordingUrl: string | null;
  steps: number;
  elapsedMs: number;
};

type SessionResponse = {
  id?: string;
  status?: string;
  output?: string | null;
  isTaskSuccessful?: boolean | null;
  stepCount?: number | null;
  liveUrl?: string | null;
  recordingUrls?: string[] | null;
};

const TERMINAL = new Set(["finished", "stopped", "failed"]);

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const key = process.env.BROWSER_USE_API_KEY!.trim();
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      "X-Browser-Use-API-Key": key,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`browser-use ${init?.method ?? "GET"} ${path} -> ${res.status} ${raw.slice(0, 200).replace(/\s+/g, " ")}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("browser-use returned non-JSON: " + raw.slice(0, 160));
  }
}

/**
 * Run one natural-language browser task to completion in a cloud session.
 * Resolves with the agent's verdict; throws on HTTP errors or timeout so the
 * caller can degrade to the local browser.
 */
export async function runBrowserUseTask(
  task: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<BrowserUseResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const pollMs = opts.pollMs ?? 4_000;
  const started = Date.now();

  const created = await call<SessionResponse>("/sessions", {
    method: "POST",
    body: JSON.stringify({ task }),
  });
  const sessionId = created.id ?? "";
  if (!sessionId) throw new Error("browser-use session create returned no id");

  let last: SessionResponse = created;
  while (Date.now() - started < timeoutMs) {
    if (TERMINAL.has(last.status ?? "")) break;
    await new Promise((r) => setTimeout(r, pollMs));
    last = await call<SessionResponse>(`/sessions/${sessionId}`);
  }
  if (!TERMINAL.has(last.status ?? "")) {
    throw new Error(`browser-use session ${sessionId} still ${last.status ?? "unknown"} after ${Math.round(timeoutMs / 1000)}s`);
  }

  return {
    sessionId,
    success: last.isTaskSuccessful === true,
    output: (last.output ?? "").trim(),
    liveUrl: last.liveUrl ?? null,
    recordingUrl: last.recordingUrls?.[last.recordingUrls.length - 1] ?? null,
    steps: last.stepCount ?? 0,
    elapsedMs: Date.now() - started,
  };
}
