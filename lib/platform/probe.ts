import type { ServiceId } from "./services";

/* Verifying a credential before trusting it.

   A bad key must fail where a human can see it — on the Settings form — not
   later inside a pipeline stage where the error reads as "deploy failed" and
   costs a whole run to diagnose. Every connected service is therefore probed
   with a read-only call at the moment it is saved, and the provider's own words
   are surfaced.

   These same probes back `scripts/verify-credentials.mjs`, so an operator
   checking their defaults and a user connecting an account run identical logic. */

export type ProbeResult = {
  ok: boolean;
  /** the account or identity the credential belongs to, when the service says */
  label?: string | null;
  detail?: string;
};

const timeout = (ms = 15_000) => AbortSignal.timeout(ms);

async function expectOk(res: Response, what: string): Promise<ProbeResult> {
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, detail: `${what} rejected that key (HTTP ${res.status}).` };
  }
  return { ok: false, detail: `${what} returned HTTP ${res.status}.` };
}

async function probeGithub(token: string): Promise<ProbeResult> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "lastmile",
    },
    signal: timeout(),
  });

  const base = await expectOk(res, "GitHub");
  if (!base.ok) return base;

  const body = (await res.json()) as { login?: string };
  const scopes = res.headers.get("x-oauth-scopes") ?? "";

  /* Creating a repository is the one permission this product actually needs
     from GitHub. A classic token reports it in a header; a fine-grained token
     reports nothing, so that case is called out rather than guessed. */
  if (scopes && !scopes.includes("repo")) {
    return {
      ok: false,
      detail: `The token works but cannot create repositories (scopes: ${scopes}). Add "repo".`,
    };
  }

  return {
    ok: true,
    label: body.login ?? null,
    detail: scopes === "" ? "fine-grained token — upload/enable repo creation" : undefined,
  };
}

async function probeVercel(token: string): Promise<ProbeResult> {
  const res = await fetch("https://api.vercel.com/v2/user", {
    headers: { Authorization: `Bearer ${token}` },
    signal: timeout(),
  });
  const base = await expectOk(res, "Vercel");
  if (!base.ok) return base;

  const body = (await res.json()) as { user?: { username?: string; email?: string } };
  return { ok: true, label: body.user?.username ?? body.user?.email ?? null };
}

async function probeRender(key: string): Promise<ProbeResult> {
  const res = await fetch("https://api.render.com/v1/owners?limit=1", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: timeout(),
  });
  const base = await expectOk(res, "Render");
  if (!base.ok) return base;

  const body = (await res.json()) as { owner?: { name?: string } }[];
  return { ok: true, label: Array.isArray(body) ? (body[0]?.owner?.name ?? null) : null };
}

async function probeSearch(key: string): Promise<ProbeResult> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key, query: "connectivity check", max_results: 1 }),
    signal: timeout(),
  });
  return expectOk(res, "Tavily");
}

async function probeExa(key: string): Promise<ProbeResult> {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query: "connectivity check", numResults: 1 }),
    signal: timeout(),
  });
  return expectOk(res, "Exa");
}

async function probeBrowser(key: string): Promise<ProbeResult> {
  const base = (
    process.env.BROWSER_USE_BASE_URL ?? "https://api.browser-use.com/api/v3"
  ).replace(/\/+$/, "");

  const res = await fetch(`${base}/sessions`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: timeout(),
  });

  /* Only a rejection is meaningful here: a listing endpoint may answer 405 to
     GET while accepting the key, so anything that is not an auth failure counts
     as reachable. */
  if (res.status === 401 || res.status === 403) {
    return { ok: false, detail: "The live-QA browser rejected that key." };
  }
  return { ok: true };
}

const PROBES: Record<ServiceId, (value: string) => Promise<ProbeResult>> = {
  github: probeGithub,
  vercel: probeVercel,
  render: probeRender,
  search: probeSearch,
  exa: probeExa,
  browser: probeBrowser,
};

/** Check a credential against its service. Never throws — a network problem is
    reported as an unsuccessful probe, not as an exception in a form handler. */
export async function probeService(id: ServiceId, value: string): Promise<ProbeResult> {
  if (!value.trim()) return { ok: false, detail: "That key is empty." };
  try {
    return await PROBES[id](value.trim());
  } catch {
    return { ok: false, detail: "Could not reach the service to verify that key." };
  }
}
