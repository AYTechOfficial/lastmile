/* Web search that cannot fail a run.

   The research agent's whole job is to ground a brief in what is actually on
   the web, so the one outcome that must never happen is "search is broken, so
   the run is over". The previous build's chain (Tavily → Exa → keyless) treated
   a dead rung as fatal. This one is built the other way round: every rung is
   optional, each is tried in order, and if all of them are down the caller gets
   an empty result set with a reason — not an exception.

   The chain, and why each rung is here:

     1. Tavily     — best relevance, and the only one that returns extracted
                     page content alongside the links. Used first when a key
                     exists.
     2. Exa        — semantic index; catches the queries a keyword engine
                     misses. Used when a key exists.
     3. DuckDuckGo — KEYLESS. Two endpoints: the Instant Answer API (JSON, very
                     reliable, thin) and the HTML endpoint (rich, and the real
                     fallback). This is the rung that makes "no keys at all"
                     still work.
     4. Wikipedia  — KEYLESS, last resort. Narrow, but it is a real index with a
                     stable API, so it answers the "who are the competitors"
                     class of query even when the general engines are blocked.

   Results from every rung are normalised to one `SearchHit` shape, deduplicated
   by URL, and tagged with the provider that produced them, so the brief can
   cite where each claim came from — which is what makes the research stage
   verifiable rather than decorative. */

import { resolveServiceCredential, SERVICES } from "../platform/services";

/* ————————————————————————— shapes ————————————————————————— */

export type SearchHit = {
  title: string;
  url: string;
  host: string;
  /** the engine's summary or extracted snippet */
  snippet: string;
  provider: string;
};

export type SearchOutcome = {
  hits: SearchHit[];
  /** which rung actually answered — "none" when the whole chain was down */
  provider: string;
  /** every rung that was tried, with what happened, for the run log */
  attempts: { provider: string; ok: boolean; count: number; detail?: string }[];
  /** set when the chain degraded, so the brief can say so honestly */
  degradedReason: string | null;
};

export type SearchOptions = {
  /** the user whose own search key should win over the platform's */
  userId?: string | null;
  /** how many hits to return in total */
  max?: number;
  /** a hard ceiling on the whole chain, so research can budget its time */
  budgetMs?: number;
  /** an engine the user chose at run start, tried first. The rest of the chain
      still stands behind it — a preference, never a single point of failure. */
  prefer?: string | null;
};

/** The rungs, in default order. `prefer` moves one to the front without
    removing the others.

    The keyed rungs come first because they give the best relevance. Everything
    after DuckDuckGo is KEYLESS and independent of the general web indexes —
    which is what makes the chain effectively impossible to exhaust:

      · DuckDuckGo  — general web. Rich when it answers, and increasingly
                      bot-hostile, which is why it is no longer load-bearing.
      · Hacker News — what practitioners said, indexed and free.
      · Stack Exchange — the technical pain points, free and stable.
      · GitHub      — existing open-source projects, i.e. real competitors.
      · Wikipedia   — entity facts, free and the most reliable of the five.

    Five independent operators have to be down at once for a query to come back
    empty, and the measured behaviour is that the last four are all reachable
    from a plain serverless egress. */
const RUNGS = [
  "tavily",
  "exa",
  "duckduckgo",
  "hackernews",
  "stackexchange",
  "github",
  "wikipedia",
] as const;

export function searchOrder(prefer?: string | null): string[] {
  const chosen = prefer?.trim().toLowerCase();
  if (!chosen || !(RUNGS as readonly string[]).includes(chosen)) return [...RUNGS];
  return [chosen, ...RUNGS.filter((r) => r !== chosen)];
}

/* ————————————————————————— the entry point ————————————————————————— */

/** Run one query through the chain. Never throws. */
export async function webSearch(
  query: string,
  options: SearchOptions = {},
): Promise<SearchOutcome> {
  const max = options.max ?? 6;
  const deadline = Date.now() + (options.budgetMs ?? 45_000);

  const attempts: SearchOutcome["attempts"] = [];
  const hits: SearchHit[] = [];

  /* The order is the default chain, unless the user picked an engine at run
     start — in which case that engine leads and the others still follow. */
  for (const rung of searchOrder(options.prefer)) {
    if (Date.now() >= deadline) break;

    if (rung === "tavily") {
      const key = await searchKey("TAVILY_API_KEY", options.userId);
      if (!key) continue;
      const result = await tavily(query, key, max, deadline);
      attempts.push(result.attempt);
      hits.push(...result.hits);
    } else if (rung === "exa") {
      const key = await searchKey("EXA_API_KEY", options.userId);
      if (!key) continue;
      const result = await exa(query, key, max, deadline);
      attempts.push(result.attempt);
      hits.push(...result.hits);
    } else if (rung === "duckduckgo") {
      /* Keyless — always attempted, which is what makes a no-key install work. */
      const ddg = await duckDuckGo(query, max, deadline);
      attempts.push(ddg.attempt);
      hits.push(...ddg.hits);
    } else if (rung === "hackernews") {
      /* These three are keyword indexes, not phrase engines: handing them a
         whole question returns nothing useful, so they get the reduced form. */
      const hn = await hackerNews(keywords(query), max, deadline);
      attempts.push(hn.attempt);
      hits.push(...hn.hits);
    } else if (rung === "stackexchange") {
      const se = await stackExchange(keywords(query), max, deadline);
      attempts.push(se.attempt);
      hits.push(...se.hits);
    } else if (rung === "github") {
      const gh = await githubRepos(keywords(query), max, deadline);
      attempts.push(gh.attempt);
      hits.push(...gh.hits);
    } else {
      const wiki = await wikipedia(query, max, deadline);
      attempts.push(wiki.attempt);
      hits.push(...wiki.hits);
    }

    /* Enough to work with — stop walking and save the budget. */
    if (dedupe(hits).length >= 3) return finish(hits, rung, attempts, max);
  }

  const deduped = dedupe(hits).slice(0, max);
  const answered = attempts.filter((a) => a.ok && a.count > 0).map((a) => a.provider);

  if (deduped.length === 0) {
    return {
      hits: [],
      provider: "none",
      attempts,
      degradedReason:
        "no search provider returned results — the brief is built from the model's own knowledge, and is marked as such",
    };
  }

  return {
    hits: deduped,
    provider: answered[0] ?? "mixed",
    attempts,
    degradedReason: answered.length === 0 ? "every search provider failed" : null,
  };
}

function finish(
  hits: SearchHit[],
  provider: string,
  attempts: SearchOutcome["attempts"],
  max: number,
): SearchOutcome {
  return { hits: dedupe(hits).slice(0, max), provider, attempts, degradedReason: null };
}

/** One user key or the platform default — the same rule as every other
    service. Tavily and Exa are separate service rows, so each resolves its own
    credential; the env var is the fallback when neither a user nor the
    platform row holds a key. */
async function searchKey(envVar: string, userId?: string | null): Promise<string | null> {
  const service: "search" | "exa" = envVar === "EXA_API_KEY" ? "exa" : "search";
  const own = await resolveServiceCredential(userId ?? null, service);
  if (own.source === "user" && own.value) return own.value;

  /* The platform default for either engine lives in the same place — the
     operator's env — so read it directly when the platform row is empty. */
  return process.env[envVar]?.trim() || null;
}

/* ————————————————————————— rung 1: Tavily ————————————————————————— */

async function tavily(
  query: string,
  key: string,
  max: number,
  deadline: number,
): Promise<{ hits: SearchHit[]; attempt: SearchOutcome["attempts"][number] }> {
  const provider = "tavily";
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: Math.min(max, 8),
        search_depth: "basic",
        /* Tavily's own extractor, so the brief can quote a page without a
           second fetch for every link. */
        include_answer: false,
      }),
      signal: AbortSignal.timeout(Math.max(5_000, Math.min(20_000, deadline - Date.now()))),
    });

    if (!res.ok) {
      return { hits: [], attempt: { provider, ok: false, count: 0, detail: `HTTP ${res.status}` } };
    }

    const body = (await res.json()) as {
      results?: { title?: string; url?: string; content?: string }[];
    };

    const hits = (body.results ?? [])
      .filter((r): r is { title?: string; url: string; content?: string } => Boolean(r.url))
      .map((r) => toHit(r.url, r.title ?? r.url, r.content ?? "", provider));

    return { hits, attempt: { provider, ok: true, count: hits.length } };
  } catch (error) {
    return { hits: [], attempt: { provider, ok: false, count: 0, detail: errText(error) } };
  }
}

/* ————————————————————————— rung 2: Exa ————————————————————————— */

async function exa(
  query: string,
  key: string,
  max: number,
  deadline: number,
): Promise<{ hits: SearchHit[]; attempt: SearchOutcome["attempts"][number] }> {
  const provider = "exa";
  try {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        query,
        numResults: Math.min(max, 8),
        contents: { text: { maxCharacters: 1200 } },
      }),
      signal: AbortSignal.timeout(Math.max(5_000, Math.min(20_000, deadline - Date.now()))),
    });

    if (!res.ok) {
      return { hits: [], attempt: { provider, ok: false, count: 0, detail: `HTTP ${res.status}` } };
    }

    const body = (await res.json()) as {
      results?: { title?: string; url?: string; text?: string }[];
    };

    const hits = (body.results ?? [])
      .filter((r): r is { title?: string; url: string; text?: string } => Boolean(r.url))
      .map((r) => toHit(r.url, r.title ?? r.url, r.text ?? "", provider));

    return { hits, attempt: { provider, ok: true, count: hits.length } };
  } catch (error) {
    return { hits: [], attempt: { provider, ok: false, count: 0, detail: errText(error) } };
  }
}

/* ————————————————————————— rung 3: DuckDuckGo (keyless) ————————————————————————— */

/** DuckDuckGo has no official search API, so this uses the two endpoints that
    exist: the Instant Answer API (JSON, stable, thin) and the HTML endpoint
    (rich, and what a browser would get). The HTML one is tried second because
    it is the one that can be rate limited, and the JSON one is a cheap way to
    answer the entity-style queries.

    Both are best-effort by nature. That is exactly why they sit behind the two
    keyed rungs and in front of Wikipedia rather than being the only option. */
async function duckDuckGo(
  query: string,
  max: number,
  deadline: number,
): Promise<{ hits: SearchHit[]; attempt: SearchOutcome["attempts"][number] }> {
  const provider = "duckduckgo";

  const instant = await ddgInstant(query, max, deadline);
  if (instant.length >= 3) {
    return { hits: instant, attempt: { provider, ok: true, count: instant.length } };
  }

  const html = await ddgHtml(query, max, deadline);
  const hits = dedupe([...instant, ...html]);

  return {
    hits,
    attempt: {
      provider,
      ok: hits.length > 0,
      count: hits.length,
      detail: hits.length === 0 ? "both DuckDuckGo endpoints returned nothing" : undefined,
    },
  };
}

async function ddgInstant(query: string, max: number, deadline: number): Promise<SearchHit[]> {
  try {
    const url = new URL("https://api.duckduckgo.com/");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");
    url.searchParams.set("no_redirect", "1");

    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(Math.max(4_000, Math.min(12_000, deadline - Date.now()))),
    });
    if (!res.ok) return [];

    const body = (await res.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      AbstractSource?: string;
      Heading?: string;
      RelatedTopics?: { Text?: string; FirstURL?: string; Topics?: { Text?: string; FirstURL?: string }[] }[];
    };

    const hits: SearchHit[] = [];

    if (body.AbstractText && body.AbstractURL) {
      hits.push(
        toHit(
          body.AbstractURL,
          body.Heading || body.AbstractSource || "DuckDuckGo summary",
          body.AbstractText,
          "duckduckgo",
        ),
      );
    }

    /* RelatedTopics is a mixed list — some entries are groups with their own
       Topics array, which is a shape the API has always had. */
    for (const topic of body.RelatedTopics ?? []) {
      const flat = topic.Topics ?? [topic];
      for (const t of flat) {
        if (!t.FirstURL || !t.Text) continue;
        hits.push(toHit(t.FirstURL, t.Text.split(" - ")[0] || t.Text, t.Text, "duckduckgo"));
        if (hits.length >= max) return hits;
      }
    }

    return hits;
  } catch {
    return [];
  }
}

/** The HTML endpoint. Parsed with regexes on purpose: pulling in an HTML parser
    for four fields would be the largest dependency in the runner, and the
    markup here is one stable result list. Every field is optional — a layout
    change degrades to fewer hits, never to an exception. */
async function ddgHtml(query: string, max: number, deadline: number): Promise<SearchHit[]> {
  try {
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
        accept: "text/html",
      },
      body: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
      signal: AbortSignal.timeout(Math.max(5_000, Math.min(15_000, deadline - Date.now()))),
    });

    if (!res.ok) return [];
    const html = await res.text();

    const hits: SearchHit[] = [];
    /* Each result is an anchor with class result__a carrying the title, and a
       sibling with class result__snippet carrying the text. */
    const linkRe =
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi;

    const links: { url: string; title: string }[] = [];
    let match: RegExpExecArray | null;
    while ((match = linkRe.exec(html)) !== null) {
      const url = unwrapDdg(match[1]);
      if (!url) continue;
      links.push({ url, title: strip(match[2]) });
      if (links.length >= max * 2) break;
    }

    const snippets: string[] = [];
    while ((match = snippetRe.exec(html)) !== null) {
      snippets.push(strip(match[1]));
    }

    links.forEach((link, i) => {
      hits.push(toHit(link.url, link.title || link.url, snippets[i] ?? "", "duckduckgo"));
    });

    return hits;
  } catch {
    return [];
  }
}

/** DuckDuckGo wraps outbound links in a redirect: //duckduckgo.com/l/?uddg=<enc>.
    The real destination is in the `uddg` parameter. */
function unwrapDdg(href: string): string | null {
  try {
    const normalized = href.startsWith("//") ? "https:" + href : href;
    const url = new URL(normalized);
    const target = url.searchParams.get("uddg");
    const real = target ? decodeURIComponent(target) : normalized;
    if (!/^https?:\/\//i.test(real)) return null;
    return real;
  } catch {
    return null;
  }
}

/* ————————————————————————— rung 4: Hacker News (keyless) ————————————————————————— */

/** Algolia's HN index. Free, keyless, generous, and genuinely useful for a
    market brief: the comments are where practitioners say what they use and
    what frustrates them. */
async function hackerNews(
  query: string,
  max: number,
  deadline: number,
): Promise<{ hits: SearchHit[]; attempt: SearchOutcome["attempts"][number] }> {
  const provider = "hackernews";
  try {
    const url = new URL("https://hn.algolia.com/api/v1/search");
    url.searchParams.set("query", query);
    url.searchParams.set("hitsPerPage", String(Math.min(max, 8)));
    url.searchParams.set("tags", "(story,comment)");

    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(Math.max(4_000, Math.min(12_000, deadline - Date.now()))),
    });
    if (!res.ok) {
      return { hits: [], attempt: { provider, ok: false, count: 0, detail: `HTTP ${res.status}` } };
    }

    const body = (await res.json()) as {
      hits?: { title?: string; story_title?: string; url?: string; story_url?: string; objectID?: string; comment_text?: string }[];
    };

    const hits = (body.hits ?? [])
      .map((h) => {
        const url = h.url ?? h.story_url ?? `https://news.ycombinator.com/item?id=${h.objectID}`;
        const title = h.title ?? h.story_title ?? "Hacker News discussion";
        return toHit(url, title, strip(h.comment_text ?? ""), provider);
      })
      .filter((h) => h.url);

    return { hits, attempt: { provider, ok: hits.length > 0, count: hits.length } };
  } catch (error) {
    return { hits: [], attempt: { provider, ok: false, count: 0, detail: errText(error) } };
  }
}

/* ————————————————————————— rung 5: Stack Exchange (keyless) ————————————————————————— */

/** Where the technical pain points are written down explicitly. Keyless with a
    quota that a pipeline will never approach. */
async function stackExchange(
  query: string,
  max: number,
  deadline: number,
): Promise<{ hits: SearchHit[]; attempt: SearchOutcome["attempts"][number] }> {
  const provider = "stackexchange";
  try {
    const url = new URL("https://api.stackexchange.com/2.3/search/advanced");
    url.searchParams.set("order", "desc");
    url.searchParams.set("sort", "relevance");
    url.searchParams.set("q", query);
    url.searchParams.set("site", "stackoverflow");
    url.searchParams.set("pagesize", String(Math.min(max, 8)));

    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(Math.max(4_000, Math.min(12_000, deadline - Date.now()))),
    });
    if (!res.ok) {
      return { hits: [], attempt: { provider, ok: false, count: 0, detail: `HTTP ${res.status}` } };
    }

    const body = (await res.json()) as {
      items?: { title?: string; link?: string; body?: string; tags?: string[] }[];
    };

    const hits = (body.items ?? [])
      .filter((i) => Boolean(i.link))
      .map((i) => toHit(i.link!, strip(i.title ?? "Stack Overflow question"), strip(i.body ?? ""), provider));

    return { hits, attempt: { provider, ok: hits.length > 0, count: hits.length } };
  } catch (error) {
    return { hits: [], attempt: { provider, ok: false, count: 0, detail: errText(error) } };
  }
}

/* ————————————————————————— rung 6: GitHub (keyless) ————————————————————————— */

/** Repository search. For a product brief this is a first-class competitor
    source: an open-source project doing the same job is the strongest possible
    evidence that the space is occupied. Unauthenticated calls are rate limited
    but sufficient, and the platform token is used when it resolves. */
async function githubRepos(
  query: string,
  max: number,
  deadline: number,
): Promise<{ hits: SearchHit[]; attempt: SearchOutcome["attempts"][number] }> {
  const provider = "github";
  try {
    const url = new URL("https://api.github.com/search/repositories");
    url.searchParams.set("q", query);
    url.searchParams.set("per_page", String(Math.min(max, 8)));
    url.searchParams.set("sort", "stars");

    const token = process.env.GITHUB_TOKEN?.trim();
    const res = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(Math.max(4_000, Math.min(12_000, deadline - Date.now()))),
    });
    if (!res.ok) {
      return { hits: [], attempt: { provider, ok: false, count: 0, detail: `HTTP ${res.status}` } };
    }

    const body = (await res.json()) as {
      items?: { full_name?: string; html_url?: string; description?: string; stargazers_count?: number }[];
    };

    const hits = (body.items ?? [])
      .filter((i) => Boolean(i.html_url))
      .map((i) =>
        toHit(
          i.html_url!,
          i.full_name ?? "GitHub repository",
          `${i.description ?? ""}${i.stargazers_count ? ` (${i.stargazers_count} stars)` : ""}`,
          provider,
        ),
      );

    return { hits, attempt: { provider, ok: hits.length > 0, count: hits.length } };
  } catch (error) {
    return { hits: [], attempt: { provider, ok: false, count: 0, detail: errText(error) } };
  }
}

/* ————————————————————————— rung 7: Wikipedia (keyless) ————————————————————————— */

/** Not a general search engine, and not pretending to be: it is the last rung
    because it is always reachable and always returns something for a
    product/market query, which is what keeps a keyless install from producing
    an empty brief. */
async function wikipedia(
  query: string,
  max: number,
  deadline: number,
): Promise<{ hits: SearchHit[]; attempt: SearchOutcome["attempts"][number] }> {
  const provider = "wikipedia";
  try {
    /* A whole sentence is a poor Wikipedia query — the search list endpoint
       matches it literally and returns noise. Its full-text search is much
       better with the distinctive keywords, so the query is reduced first and
       the most specific form is tried before the reduced one. */
    const variants = [...new Set([query, keywords(query).split(" ").slice(0, 2).join(" ")])].filter(Boolean);

    const res = await fetch(
      url({
        action: "query",
        list: "search",
        srsearch: variants[0],
        srlimit: String(Math.min(max, 6)),
        format: "json",
        origin: "*",
      }),
      {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(Math.max(4_000, Math.min(12_000, deadline - Date.now()))),
      },
    );

    if (!res.ok) {
      return { hits: [], attempt: { provider, ok: false, count: 0, detail: `HTTP ${res.status}` } };
    }

    let body = (await res.json()) as { query?: { search?: { title?: string; snippet?: string }[] } };
    let found = body.query?.search ?? [];

    /* Nothing for the full phrase — try the reduced keywords before giving up. */
    if (found.length === 0 && variants[1]) {
      const retry = await fetch(
        url({
          action: "query",
          list: "search",
          srsearch: variants[1],
          srlimit: String(Math.min(max, 6)),
          format: "json",
          origin: "*",
        }),
        {
          headers: { "user-agent": USER_AGENT, accept: "application/json" },
          signal: AbortSignal.timeout(Math.max(4_000, Math.min(12_000, deadline - Date.now()))),
        },
      );
      if (retry.ok) {
        body = (await retry.json()) as typeof body;
        found = body.query?.search ?? [];
      }
    }

    const hits = found.map((r) =>
      toHit(
        `https://en.wikipedia.org/wiki/${encodeURIComponent((r.title ?? "").replace(/ /g, "_"))}`,
        r.title ?? "Wikipedia",
        strip(r.snippet ?? ""),
        provider,
      ),
    );

    return { hits, attempt: { provider, ok: hits.length > 0, count: hits.length } };
  } catch (error) {
    return { hits: [], attempt: { provider, ok: false, count: 0, detail: errText(error) } };
  }
}

/** A small URL builder, so each of these seven rungs does not repeat the same
    six `searchParams.set` lines. */
function url(params: Record<string, string>): URL {
  const u = new URL("https://en.wikipedia.org/w/api.php");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
}

/** The distinctive nouns of a query: drops the filler words and the site
    scaffolding that make an engine over-match. */
const FILLER = new Set([
  "the", "a", "an", "for", "with", "and", "or", "of", "to", "in", "on", "at", "by",
  "software", "app", "application", "tool", "platform", "website", "site", "best",
  "top", "vs", "comparison", "alternatives", "review", "reviews", "guide", "2024",
  "2025", "2026", "pricing", "plans", "market", "size", "growth",
]);

function keywords(query: string): string {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !FILLER.has(w));
  /* Three words is the sweet spot for these indexes: enough to be specific,
     short enough that a strict AND-ish match still returns rows. Measured —
     four terms took Hacker News from five hits to zero. */
  return words.slice(0, 3).join(" ");
}

/* ————————————————————————— reading a page ————————————————————————— */

export type PageRead = {
  url: string;
  title: string;
  text: string;
  ok: boolean;
  detail?: string;
};

/** Fetch one page and reduce it to readable text.

    This is what makes a claim *sourced* rather than merely attributed: the
    brief can quote the competitor's own pricing page because this actually
    read it. Failures are per-page and expected — a site can refuse, redirect,
    or render entirely in JavaScript — so a dead page is reported, never thrown. */
export async function readPage(url: string, timeoutMs = 15_000): Promise<PageRead> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return { url, title: url, text: "", ok: false, detail: `HTTP ${res.status}` };
    }

    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      return { url, title: url, text: "", ok: false, detail: `not a readable page (${type || "unknown"})` };
    }

    const html = await res.text();
    const title = strip((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1] ?? "") || url;

    return { url, title, text: htmlToText(html).slice(0, 12_000), ok: true };
  } catch (error) {
    return { url, title: url, text: "", ok: false, detail: errText(error) };
  }
}

/** Tags that hold no prose, and would otherwise flood the text with CSS and
    script — the single biggest source of noise in a naive strip. */
const DEAD_TAGS = /<(script|style|noscript|svg|head|nav|footer|form|iframe)[^>]*>[\s\S]*?<\/\1>/gi;

function htmlToText(html: string): string {
  return html
    .replace(DEAD_TAGS, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ————————————————————————— helpers ————————————————————————— */

const USER_AGENT =
  "Mozilla/5.0 (compatible; LastMileBot/1.0; +https://lastmile.dev/bot)";

function toHit(url: string, title: string, snippet: string, provider: string): SearchHit {
  return { url, title: title.slice(0, 300), host: hostOf(url), snippet: snippet.slice(0, 1200), provider };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** One hit per URL, keeping the first (highest-priority rung) version. */
function dedupe(hits: SearchHit[]): SearchHit[] {
  const seen = new Map<string, SearchHit>();
  for (const hit of hits) {
    if (!hit.url || seen.has(hit.url)) continue;
    seen.set(hit.url, hit);
  }
  return [...seen.values()];
}

function strip(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function errText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /abort|timeout/i.test(message) ? "timed out" : message.slice(0, 160);
}

/* ————————————————————————— capacity view for the UI ————————————————————————— */

/* These rows report whether the *credential* resolves, and they ask the
   credential layer rather than reading an environment variable, because the
   product's rule is user's own key → platform default → nothing. The keyless
   rungs are listed too, and reported as always configured, because that is the
   truth: the research agent works with no keys at all. */

export type SearchProviderState = {
  id: string;
  label: string;
  configured: boolean;
  freeTier: string;
  /** where the platform default lives, shown as a paste target */
  keyEnv: string | null;
  signupUrl: string | null;
  /** true when this rung needs no credential at all */
  keyless: boolean;
};

const KEYED_FREE_TIER = "1,000 credits/month free, no card";
const KEYLESS_NOTE = "no key required — always available as a fallback";

/** The keyless rungs, in the order the engine reaches them. */
const KEYLESS: { id: string; label: string }[] = [
  { id: "duckduckgo", label: "DuckDuckGo" },
  { id: "hackernews", label: "Hacker News" },
  { id: "stackexchange", label: "Stack Exchange" },
  { id: "github", label: "GitHub" },
  { id: "wikipedia", label: "Wikipedia" },
];

export async function searchProviderStates(
  userId?: string | null,
): Promise<SearchProviderState[]> {
  const defs = SERVICES.filter((s) => s.id === "search" || s.id === "exa");

  const keyed = await Promise.all(
    defs.map(async (s) => {
      const { value } = await resolveServiceCredential(userId ?? null, s.id);
      return {
        id: s.id,
        label: s.label,
        configured: Boolean(value),
        freeTier: KEYED_FREE_TIER,
        keyEnv: s.envVar,
        signupUrl: s.keysUrl,
        keyless: false,
      };
    }),
  );

  return [
    ...keyed,
    ...KEYLESS.map((k) => ({
      id: k.id,
      label: k.label,
      configured: true,
      freeTier: KEYLESS_NOTE,
      keyEnv: null,
      signupUrl: null,
      keyless: true,
    })),
  ];
}
