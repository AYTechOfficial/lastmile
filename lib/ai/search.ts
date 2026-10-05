/* Search + page-reading layer for the Research Agent.

   Chain (first configured wins):
     1. Tavily      TAVILY_API_KEY    — 1,000 credits/month free, built for agents
     2. Exa         EXA_API_KEY       — generous free tier, neural search
     3. keyless                       — DuckDuckGo HTML, then Wikipedia's API

   The keyless rung matters: the agent still produces a real, sourced brief
   before anyone has signed up for anything. */

export type SearchHit = {
  title: string;
  url: string;
  snippet: string;
  /** longer excerpt when the provider returns one (Tavily/Exa do) */
  content?: string;
  score?: number;
  provider: string;
};

export type SearchResult = {
  hits: SearchHit[];
  provider: string;
  query: string;
};

export type SearchProviderState = {
  id: "tavily" | "exa" | "keyless";
  label: string;
  configured: boolean;
  signupUrl: string | null;
  freeTier: string;
  /** the variable to paste the key into; null for the keyless rung */
  keyEnv: string | null;
};

const SEARCH_PROVIDERS: Omit<SearchProviderState, "configured">[] = [
  {
    id: "tavily",
    label: "Tavily",
    signupUrl: "https://app.tavily.com/home",
    freeTier: "1,000 credits/month free, no card",
    keyEnv: "TAVILY_API_KEY",
  },
  {
    id: "exa",
    label: "Exa",
    signupUrl: "https://dashboard.exa.ai/api-keys",
    freeTier: "free monthly credits, no card",
    keyEnv: "EXA_API_KEY",
  },
  {
    id: "keyless",
    label: "DuckDuckGo",
    signupUrl: null,
    freeTier: "no key required — the fallback rung, always on",
    keyEnv: null,
  },
];

export function searchProviderStates(): SearchProviderState[] {
  const order = process.env.SEARCH_PROVIDER_ORDER?.split(",").map((s) => s.trim()).filter(Boolean);
  const list = order?.length
    ? [...SEARCH_PROVIDERS].sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      })
    : [...SEARCH_PROVIDERS];
  return list.map((p) => ({
    ...p,
    configured: p.id === "keyless" ? true : Boolean(process.env[p.id === "tavily" ? "TAVILY_API_KEY" : "EXA_API_KEY"]?.trim()),
  }));
}

export function activeSearchProvider(): SearchProviderState {
  return searchProviderStates().find((p) => p.configured) ?? searchProviderStates()[0];
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/* ————————————————————————— Tavily ————————————————————————— */

async function tavily(query: string, max: number): Promise<SearchHit[]> {
  const key = process.env.TAVILY_API_KEY!.trim();
  const res = await withTimeout(
    (signal) =>
      fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + key },
        body: JSON.stringify({
          query,
          max_results: Math.min(max, 10),
          search_depth: "basic",
          include_answer: false,
          include_raw_content: false,
        }),
        signal,
        cache: "no-store",
      }),
    20_000,
  );
  if (!res.ok) throw new Error("tavily " + res.status + " " + (await res.text()).slice(0, 140));
  const json = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string; score?: number }[];
  };
  return (json.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      title: decodeEntities(r.title ?? r.url!),
      url: r.url!,
      snippet: decodeEntities(r.content ?? "").slice(0, 300),
      content: r.content ? decodeEntities(r.content).slice(0, 2400) : undefined,
      score: r.score,
      provider: "tavily",
    }));
}

/* ————————————————————————— Exa ————————————————————————— */

async function exa(query: string, max: number): Promise<SearchHit[]> {
  const key = process.env.EXA_API_KEY!.trim();
  const res = await withTimeout(
    (signal) =>
      fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({
          query,
          numResults: Math.min(max, 10),
          type: "auto",
          contents: { text: { maxCharacters: 1600 } },
        }),
        signal,
        cache: "no-store",
      }),
    20_000,
  );
  if (!res.ok) throw new Error("exa " + res.status + " " + (await res.text()).slice(0, 140));
  const json = (await res.json()) as {
    results?: { title?: string; url?: string; text?: string; score?: number }[];
  };
  return (json.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      title: decodeEntities(r.title ?? r.url!),
      url: r.url!,
      snippet: decodeEntities((r.text ?? "").slice(0, 300)),
      content: r.text ? decodeEntities(r.text).slice(0, 2400) : undefined,
      score: r.score,
      provider: "exa",
    }));
}

/* ————————————————————— keyless: DuckDuckGo ————————————————————— */

function unwrapDdg(href: string): string {
  // DDG wraps outbound links: //duckduckgo.com/l/?uddg=<urlencoded>&rut=...
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fall through */
    }
  }
  return href.startsWith("//") ? "https:" + href : href;
}

async function duckduckgo(query: string, max: number): Promise<SearchHit[]> {
  const res = await withTimeout(
    (signal) =>
      fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
        headers: { "user-agent": UA, accept: "text/html" },
        signal,
        cache: "no-store",
      }),
    20_000,
  );
  if (!res.ok) throw new Error("duckduckgo " + res.status);
  const html = await res.text();

  const hits: SearchHit[] = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snipRe.exec(html))) snippets.push(decodeEntities(sm[1]).slice(0, 300));

  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = linkRe.exec(html)) && hits.length < max) {
    const url = unwrapDdg(m[1]);
    if (!/^https?:\/\//.test(url)) {
      i++;
      continue;
    }
    hits.push({
      title: decodeEntities(m[2]) || url,
      url,
      snippet: snippets[i] ?? "",
      provider: "keyless",
    });
    i++;
  }
  if (hits.length === 0) throw new Error("duckduckgo returned no parseable results");
  return hits;
}

/* ————————————————————— keyless: Wikipedia ————————————————————— */

async function wikipedia(query: string, max: number): Promise<SearchHit[]> {
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=" +
    Math.min(max, 8) +
    "&srsearch=" +
    encodeURIComponent(query);
  const res = await withTimeout(
    (signal) => fetch(url, { headers: { "user-agent": UA }, signal, cache: "no-store" }),
    15_000,
  );
  if (!res.ok) throw new Error("wikipedia " + res.status);
  const json = (await res.json()) as {
    query?: { search?: { title: string; snippet: string }[] };
  };
  return (json.query?.search ?? []).map((r) => ({
    title: r.title,
    url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(r.title.replace(/ /g, "_")),
    snippet: decodeEntities(r.snippet),
    provider: "keyless",
  }));
}

/* ————————————————————————— public API ————————————————————————— */

export async function searchWeb(
  query: string,
  { max = 6 }: { max?: number } = {},
): Promise<SearchResult> {
  const states = searchProviderStates().filter((p) => p.configured);
  const errors: string[] = [];

  for (const state of states) {
    try {
      if (state.id === "tavily") return { hits: await tavily(query, max), provider: state.label, query };
      if (state.id === "exa") return { hits: await exa(query, max), provider: state.label, query };
      try {
        return { hits: await duckduckgo(query, max), provider: "DuckDuckGo", query };
      } catch (ddgErr) {
        errors.push("duckduckgo: " + (ddgErr instanceof Error ? ddgErr.message : String(ddgErr)));
        return { hits: await wikipedia(query, max), provider: "Wikipedia", query };
      }
    } catch (err) {
      errors.push(state.id + ": " + (err instanceof Error ? err.message : String(err)));
    }
  }

  throw new Error("all search providers failed — " + errors.join("; "));
}

/** Strip a page down to readable text. Jina's reader is keyless and free. */
export async function fetchPage(url: string, maxChars = 4000): Promise<string | null> {
  try {
    const res = await withTimeout(
      (signal) =>
        fetch("https://r.jina.ai/" + url, {
          headers: { accept: "text/plain", "user-agent": UA },
          signal,
          cache: "no-store",
        }),
      25_000,
    );
    if (res.ok) {
      const text = await res.text();
      const clean = text.replace(/\n{3,}/g, "\n\n").trim();
      if (clean.length > 200) return clean.slice(0, maxChars);
    }
  } catch {
    /* fall through to a direct fetch */
  }

  try {
    const res = await withTimeout(
      (signal) => fetch(url, { headers: { "user-agent": UA }, signal, cache: "no-store" }),
      15_000,
    );
    if (!res.ok) return null;
    const html = await res.text();
    const text = html
      .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text.length > 200 ? text.slice(0, maxChars) : null;
  } catch {
    return null;
  }
}

/** Hostname without www, for compact source lists. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
