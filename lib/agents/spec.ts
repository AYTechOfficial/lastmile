/* Spec derivation — the handoff from Research (stage 01) to the checkpoint.

   Today this is a deterministic projection of the research brief: the same
   brief always produces the same spec, which is what makes the checkpoint
   reviewable and the verification tests reproducible. The full Spec Agent
   (its own model pass over the brief, plus per-flow test plans) plugs in here
   behind this same return shape. */

import type { ResearchBrief } from "./research";
import { needsAccounts, sanitizeFlows, wantsPayments, wantsTeams } from "./scope";

export type ProductSpec = {
  title: string;
  summary: string;
  /** which research findings this spec is built on */
  positioning: string;
  gap: string;
  audience: string[];
  stack: string[];
  flows: { name: string; criteria: string[] }[];
  dataModel: { table: string; columns: string[] }[];
  routes: { path: string; purpose: string }[];
  scope: { in: string[]; out: string[] };
  risks: string[];
  productionChecklist: string[];
  /** total testable assertions the verification stage will run */
  acceptance: number;
  variant: number;
  origin: "research" | "fallback";
};

const STOP = new Set(["a", "an", "the", "for", "with", "of", "to", "and", "in", "on", "my", "that"]);

function words(idea: string): string[] {
  return idea
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function titleCase(s: string): string {
  const clean = s.trim().replace(/\.$/, "");
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function subjectOf(idea: string): { noun: string; slug: string } {
  const kw = words(idea);
  const slug = kw.slice(0, 3).join("-") || "app";
  const noun = kw.slice(-1)[0] ?? "record";
  return { noun, slug };
}

function snake(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase().slice(0, 32) || "record";
}

export function specFromBrief(brief: ResearchBrief, variant = 1): ProductSpec {
  const title = titleCase(brief.idea);
  const { noun } = subjectOf(brief.idea);
  // scope discipline: research flows pass through the same gate the fallback
  // uses, so a game never inherits a SaaS's signup/invite/payment flows
  const flows = brief.flows.length > 0 ? sanitizeFlows(brief.flows, brief.idea) : fallbackFlows(noun, brief.idea);
  const acceptance = flows.reduce((n, f) => n + f.criteria.length, 0);
  const accounts = needsAccounts(brief.idea);

  const stack = (brief.stack.length > 0 ? brief.stack.map((s) => s.name) : ["Next.js", "Postgres", "Tailwind", "Auth.js"])
    .filter((s) => accounts || !/auth/i.test(s));

  const dataModel = [
    {
      table: snake(noun),
      columns: [
        "id · uuid · pk",
        ...(accounts ? ["owner_id · → user"] : []),
        "title · text · required",
        "status · enum(draft, active, archived)",
        "created_at · timestamptz",
      ],
    },
    ...(accounts
      ? [
          {
            table: "user",
            columns: ["id · uuid · pk", "email · text · unique", "name · text", "created_at · timestamptz"],
          },
        ]
      : []),
  ];

  const routes = [
    { path: "/", purpose: "what this does, in one screen, for a stranger" },
    ...(accounts
      ? [
          { path: "/signup · /login", purpose: "email + password and OAuth, sessions that survive reload" },
          { path: "/dashboard", purpose: `the ${noun} list — the app's centre of gravity` },
          { path: `/dashboard/${noun}s/[id]`, purpose: "one record, edited in place, every change persisted" },
        ]
      : []),
    { path: "/api/health", purpose: "the endpoint verification pings before it drives the UI" },
  ];

  const scopeIn = flows.map((f) => f.name);
  const scopeOut = [
    // honest out-of-scope lines: auth is listed as OUT unless the idea asked for it
    ...(accounts ? [] : ["Accounts, login or signup — the product is fully usable without one"]),
    "Billing beyond a rendered checkout stub",
    "Team roles and granular permissions",
    "Mobile native apps",
    "Real-time collaboration",
  ];

  return {
    title,
    summary:
      (brief.positioning ? brief.positioning + " " : "") +
      (brief.gap ? brief.gap + " " : "") +
      `Scoped to ${flows.length} core flows and ${acceptance} testable assertions — nothing ships that verification cannot check.`,
    positioning: brief.positioning,
    gap: brief.gap,
    audience: brief.audience,
    stack,
    flows,
    dataModel,
    routes,
    scope: { in: scopeIn, out: scopeOut },
    risks: brief.risks.length > 0 ? brief.risks : ["Category is crowded — differentiation must be visible on the first screen."],
    productionChecklist: brief.productionChecklist,
    acceptance,
    variant,
    origin: brief.quality === "offline" ? "fallback" : "research",
  };
}

/** Kept for callers with no brief (legacy stub runs, seeded runs). */
export function fallbackSpec(idea: string, variant = 1): ProductSpec {
  const title = titleCase(idea);
  const { noun } = subjectOf(idea);
  const accounts = needsAccounts(idea);
  const flows = fallbackFlows(noun, idea);
  return {
    title,
    summary:
      `A focused ${noun}: the shortest path to the one action it exists for. ` +
      "No invented accounts, no half-flows — every core path is testable, so verification can prove it works end to end.",
    positioning: `A focused ${noun} — exactly what the idea names, nothing it doesn't.`,
    gap: "Simplicity beats feature lists here.",
    audience: ["People who want this exact thing, immediately, with zero setup"],
    stack: ["Next.js", "Tailwind", "TypeScript", ...(accounts ? ["Auth.js"] : [])],
    flows,
    dataModel: [
      {
        table: snake(noun),
        columns: ["id · uuid · pk", ...(accounts ? ["owner_id · → user"] : []), "title · text", "status · enum", "created_at"],
      },
    ],
    routes: [
      { path: "/", purpose: "the product, in one screen" },
      ...(accounts
        ? [
            { path: "/signup · /login", purpose: "account creation and session" },
            { path: "/dashboard", purpose: `the ${noun} list` },
          ]
        : []),
      { path: "/api/health", purpose: "the endpoint verification pings before it drives the UI" },
    ],
    scope: {
      in: flows.map((f) => f.name),
      out: [
        ...(accounts ? [] : ["Accounts, login or signup — fully usable without one"]),
        "Billing beyond a checkout stub",
        "Team roles",
      ],
    },
    risks: ["Crowded category", "Email deliverability — queued with retries, never blocking the UI"],
    productionChecklist: [
      ...(accounts ? ["Auth with sessions that survive reload"] : ["Works instantly with zero sign-up friction"]),
      "Durable state across reloads",
      "Inline validation",
    ],
    acceptance: flows.reduce((n, f) => n + f.criteria.length, 0),
    variant,
    origin: "fallback",
  };
}

/** Scope-aware default flows. Games and local tools get play/persist flows —
    never signup, invites or checkout stubs unless the idea asks for them. */
function fallbackFlows(noun: string, idea: string): { name: string; criteria: string[] }[] {
  const accounts = needsAccounts(idea);
  const teams = wantsTeams(idea);
  const pay = wantsPayments(idea);
  const flows: { name: string; criteria: string[] }[] = [];

  if (accounts) {
    flows.push({
      name: "Signup → login → dashboard",
      criteria: [
        "New account from email + password in under 30s",
        "Wrong password shows an inline error, never a blank page",
        "Session survives reload",
      ],
    });
  }

  flows.push({
    name: accounts ? `Create ${noun} record - persists on reload` : `Use the ${noun} end to end`,
    criteria: [
      accounts ? "Create from the dashboard in one screen" : "The core interaction completes with visible, immediate feedback",
      accounts ? "Data survives a hard reload" : "A full session — start, play/use, finish — works without errors",
      accounts ? "Validation errors are inline and specific" : "The UI responds to every input within 2s with zero console errors",
    ],
  });

  flows.push({
    name: accounts ? "Edit and archive a record" : "State persists across reload",
    criteria: [
      accounts ? "Edits persist" : "Progress or data survives a hard reload",
      accounts ? "Archived items stay out of the default list" : "A fresh visit offers a sensible empty/first-run state",
    ],
  });

  if (teams) {
    flows.push({
      name: "Invite teammate by email",
      criteria: ["Invite renders a pending state instantly", "Email queuing is idempotent"],
    });
  }
  if (pay) {
    flows.push({
      name: "Payment stub renders in checkout",
      criteria: ["Checkout skeleton renders for every plan", "No live charge is possible in v1"],
    });
  }
  return flows;
}
