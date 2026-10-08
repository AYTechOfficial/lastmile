/* Which browser the Live QA stage drives, and why it differs by plan.

   Two real constraints drove this split, and neither is cosmetic:

     · The cloud browser (Browser Use) costs money per session and needs an API
       key. Giving it to every free run means one abusive user can spend the
       operator's budget, and it makes the free tier depend on a paid service
       staying up.
     · The local Chromium path needs a machine with a browser on it. That is
       fine for a run, which already happens on a runner, and it is *free* — but
       it cannot be shown to the user as a live video feed, because there is no
       cloud session to embed.

   So the split is:

       Pro   → the cloud browser. Sessions are real, and the session's live
               view can be embedded in the run page, so the user watches the
               verification happen.
       Free  → an embedded local session. The stage drives a local Chromium on
               the runner and the run page embeds *our own* live view of it,
               streaming from the same run, rather than a third party's player.

   The important property for both: the verification runs against the deployed
   URL, and the run page shows the result. What changes is whose browser did it
   and how it is presented — never whether it happened. */

import type { PlanId } from "../plans";
import { resolveServiceCredential } from "../platform/services";
import { getPlatformData } from "../platform/settings";

export type BrowserMode = "cloud" | "local";

export type BrowserPlan = {
  mode: BrowserMode;
  /** the browser string recorded on the test report, e.g. "browser-use cloud" */
  label: string;
  /** the API key for the cloud mode, when there is one */
  apiKey: string | null;
  baseUrl: string;
  /** what the run page should render for this run */
  presentation: "cloud-session" | "embedded-local";
  /** why this mode was chosen, for the run log */
  reason: string;
};

const DEFAULT_CLOUD_BASE = "https://api.browser-use.com/api/v3";

/** Decide how this run's live QA will be driven.

    A Pro user still falls back to local when no cloud key resolves — the plan
    grants the *option*, and an unconfigured key must not fail a stage. That is
    the same rule the rest of the product follows: user's key → platform key →
    a working fallback. */
export async function planBrowser(
  plan: PlanId,
  userId: string | null,
): Promise<BrowserPlan> {
  const baseUrl = (process.env.BROWSER_USE_BASE_URL ?? DEFAULT_CLOUD_BASE).replace(/\/+$/, "");

  /* The operator's switch: the cloud session costs money, so by default it is
     a Pro feature — but the panel can open it to every run. Read fresh, so
     flipping the toggle applies to the next job with no deploy. */
  const { liveBrowser } = await getPlatformData();
  if (plan !== "pro" && liveBrowser?.cloudForAll !== true) {
    return {
      mode: "local",
      label: "local chromium (embedded)",
      apiKey: null,
      baseUrl,
      presentation: "embedded-local",
      reason: "the free plan verifies in an embedded local browser — the cloud session is a Pro feature",
    };
  }

  const { value, source } = await resolveServiceCredential(userId, "browser");

  if (!value) {
    return {
      mode: "local",
      label: "local chromium (embedded)",
      apiKey: null,
      baseUrl,
      presentation: "embedded-local",
      reason:
        plan !== "pro"
          ? "cloud browser for all is on, but no cloud browser key is configured — falling back to the embedded local browser"
          : "Pro plan, but no cloud browser key is configured — falling back to the embedded local browser",
    };
  }

  return {
    mode: "cloud",
    label: "browser-use cloud",
    apiKey: value,
    baseUrl,
    presentation: "cloud-session",
    reason:
      source === "user"
        ? "your own cloud browser key — the session's live view is on the run page"
        : plan !== "pro"
          ? "cloud browser opened to all runs by the operator — the session's live view is on the run page"
          : "the platform's cloud browser — the session's live view is on the run page",
  };
}

/* ————————————————————————— the cloud session API ————————————————————————— */

export type CloudSession = {
  id: string;
  /** the URL a browser can open to watch the session live */
  liveUrl: string | null;
  status: string;
};

/** Create a cloud browser session. Returns null rather than throwing — the
    caller decides whether to degrade to local, which is the whole point of
    having a fallback at all. */
export async function createCloudSession(
  browser: BrowserPlan,
): Promise<{ session: CloudSession | null; detail: string }> {
  if (browser.mode !== "cloud" || !browser.apiKey) {
    return { session: null, detail: "cloud mode is not active for this run" };
  }

  try {
    const res = await fetch(`${browser.baseUrl}/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${browser.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30_000),
    });

    const raw = await res.text();
    if (!res.ok) {
      return { session: null, detail: `the cloud browser answered HTTP ${res.status}: ${raw.slice(0, 200)}` };
    }

    const body = JSON.parse(raw) as {
      id?: string;
      sessionId?: string;
      liveUrl?: string;
      live_url?: string;
      status?: string;
    };

    const id = body.id ?? body.sessionId;
    if (!id) return { session: null, detail: "the cloud browser returned no session id" };

    return {
      session: {
        id,
        liveUrl: body.liveUrl ?? body.live_url ?? null,
        status: body.status ?? "created",
      },
      detail: "cloud session created",
    };
  } catch (error) {
    return {
      session: null,
      detail: `could not reach the cloud browser: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
