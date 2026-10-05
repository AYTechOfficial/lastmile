import { agentChat } from "@/lib/ai/registry";
import { asObjectArray, asString, asStringArray, extractJson } from "@/lib/ai/json";
import type { Emit, ResearchBrief } from "./research";
import type { ProductSpec } from "./spec";
import type { AgentId, PlanId } from "@/lib/platform/settings";

/* Prompt Engineer — stage between the approved spec and the Coding Agent.

   Input:  the user's idea, the research brief, the approved spec.
   Output: a Master Build Prompt — a complete product contract the Coding
           Agent executes without asking questions: architecture, file
           structure, design system, every feature (including the competitive
           edges research found), edge cases, and the quality bar.

   The structured part is validated here; the prose is assembled from it so
   the master prompt is complete even when the model is thin. */

export type DesignSystem = {
  look: string;
  colors: { background: string; surface: string; primary: string; accent: string };
  font: string;
};

export type PageSpec = { path: string; purpose: string; sections: string[] };
export type FeatureSpec = { name: string; description: string; priority: "must" | "should" };

export type MasterBuildPrompt = {
  productName: string;
  tagline: string;
  stack: string[];
  dataMode: "client";
  design: DesignSystem;
  pages: PageSpec[];
  features: FeatureSpec[];
  superiority: string[];
  edgeCases: string[];
  qualityBar: string[];
  /** the assembled prose the Coding Agent receives verbatim */
  instructions: string;
  model: string | null;
  providerLabel: string | null;
  tokens: number;
  elapsedMs: number;
};

export { type AgentEvent, type Emit } from "./research";

const AGENT: AgentId = "prompt";

const SYSTEM = `You are the Prompt Engineer inside LastMile: an elite prompt architect who turns research into a build contract another AI executes with zero follow-up questions.

Your master prompt must be:
- COMPLETE: every page, feature, state, and edge case specified. The coder cannot ask questions.
- BUILDABLE: only features achievable with a Next.js App Router app whose data persists client-side (localStorage/IndexedDB). No auth servers, no external databases, no paid APIs.
- SCOPED: build exactly what the idea names. If the approved spec has no /login route, the product has NO accounts — never invent signup, login, user profiles, invites, or checkout for it. Features the idea does not imply are hallucinations, not value.
- PRECISE: real class names, real routes, real copy direction — not adjectives.`;

function buildUserPrompt(idea: string, brief: ResearchBrief, spec: ProductSpec): string {
  const competitors = brief.competitors
    .map((c) => `- ${c.name} (${c.url}): ${c.what} · gaps: ${c.gaps.join("; ") || "none noted"}`)
    .join("\n");
  const flows = spec.flows.map((f, i) => `${i + 1}. ${f.name} — must pass: ${f.criteria.join("; ")}`).join("\n");

  return `PRODUCT IDEA: "${idea}"

RESEARCH
positioning: ${brief.positioning}
gap to exploit: ${brief.gap}
audience: ${brief.audience.join(", ")}
competitors:
${competitors || "(none — new category)"}

APPROVED SPEC (the contract)
flows + acceptance criteria:
${flows}
routes already promised: ${spec.routes.map((r) => r.path).join(", ")}
AUTH POLICY: ${
    spec.routes.some((r) => r.path.includes("login"))
      ? "the spec includes accounts — client-side demo auth only (a localStorage session flag), never a real server"
      : "NO accounts — this product is fully usable without one. Do NOT create signup, login, user-profile, invite, or checkout pages."
  }

Design the master build prompt. Return ONLY this JSON:
{
  "productName": "short, ownable product name",
  "tagline": "one line, says what it does for whom",
  "stack": ["Next.js 15 (App Router)", "React 19", "Tailwind v4", "..."],
  "design": {
    "look": "one sentence of art direction with concrete visual references",
    "colors": { "background": "#hex", "surface": "#hex", "primary": "#hex", "accent": "#hex" },
    "font": "a Google Font name + fallback"
  },
  "pages": [ { "path": "/", "purpose": "...", "sections": ["hero: ...", "..."] } ],
  "features": [ { "name": "...", "description": "behavior + UI placement + states (empty/error/success)", "priority": "must" } ],
  "superiority": ["10+ concrete edges over every competitor listed — each one testable in the UI"],
  "edgeCases": ["real edge cases: empty state, long input, double submit, offline, etc."],
  "qualityBar": ["what 'done' means: a11y, responsive breakpoints, no console errors, ..."]
}`;
}

function coerce(raw: Record<string, unknown>, idea: string, spec: ProductSpec): Omit<MasterBuildPrompt, "instructions" | "model" | "providerLabel" | "tokens" | "elapsedMs"> {
  const colors = (raw.design && typeof raw.design === "object" ? (raw.design as Record<string, unknown>).colors : null) as Record<string, unknown> | null;
  const design = raw.design && typeof raw.design === "object" ? (raw.design as Record<string, unknown>) : null;

  const features = asObjectArray(raw.features, 24)
    .map((f) => ({
      name: asString(f.name),
      description: asString(f.description),
      priority: asString(f.priority) === "should" ? ("should" as const) : ("must" as const),
    }))
    .filter((f) => f.name);

  const pages = asObjectArray(raw.pages, 12)
    .map((p) => ({
      path: asString(p.path) || "/",
      purpose: asString(p.purpose),
      sections: asStringArray(p.sections, 8),
    }))
    .filter((p) => p.path);

  return {
    productName: asString(raw.productName) || spec.title.split(/[.,—-]/)[0].slice(0, 40) || "The Product",
    tagline: asString(raw.tagline) || spec.positioning.slice(0, 120),
    stack: asStringArray(raw.stack, 8).length ? asStringArray(raw.stack, 8) : ["Next.js 15 (App Router)", "React 19", "Tailwind v4", "TypeScript"],
    dataMode: "client" as const,
    design: {
      look: asString(design?.look) || "Focused, modern tool UI — generous spacing, one accent color, crisp type.",
      colors: {
        background: asString(colors?.background) || "#0b0c10",
        surface: asString(colors?.surface) || "#14161d",
        primary: asString(colors?.primary) || "#7c7aff",
        accent: asString(colors?.accent) || "#38d9f0",
      },
      font: asString(design?.font) || "Inter, system-ui, sans-serif",
    },
    pages: pages.length > 0 ? pages : [{ path: "/", purpose: "the product, in one screen", sections: ["hero", "core tool", "how it works"] }],
    features: features.length > 0 ? features : spec.flows.map((f) => ({ name: f.name, description: f.criteria.join("; "), priority: "must" as const })),
    superiority: asStringArray(raw.superiority, 14),
    edgeCases: asStringArray(raw.edgeCases, 12),
    qualityBar: asStringArray(raw.qualityBar, 10).length
      ? asStringArray(raw.qualityBar, 10)
      : ["Zero console errors on every page", "Responsive at 390px, 768px and 1440px", "Keyboard operable, visible focus", "Empty, loading and error states on every data view"],
  };
}

/** The prose contract — assembled from validated structure, not model prose. */
export function assembleInstructions(p: Omit<MasterBuildPrompt, "instructions" | "model" | "providerLabel" | "tokens" | "elapsedMs">): string {
  const pages = p.pages.map((pg) => `- ${pg.path} — ${pg.purpose}${pg.sections.length ? " · sections: " + pg.sections.join(" | ") : ""}`).join("\n");
  const features = p.features
    .filter((f) => f.priority === "must")
    .map((f, i) => `${i + 1}. ${f.name} — ${f.description}`)
    .join("\n");
  const should = p.features.filter((f) => f.priority === "should");
  const edges = p.superiority.map((s, i) => `${i + 1}. ${s}`).join("\n");

  return [
    `Build "${p.productName}" — ${p.tagline}`,
    ``,
    `STACK: ${p.stack.join(", ")}. TypeScript. Next.js App Router (src/app), Tailwind v4 via @tailwindcss/postcss.`,
    `DATA: client-side persistence only (localStorage). Every list survives reload; nothing may require a server database.`,
    `ACCOUNTS: ${
      /login|sign[- ]?up|register/i.test(p.pages.map((pg) => pg.path).join(" "))
        ? "the spec includes accounts — implement client-side demo auth only (localStorage session flag); never a real server"
        : "NONE. This product must NOT have signup, login, user profiles, invites, or checkout. It is fully usable the moment it loads."
    }`,
    ``,
    `DESIGN SYSTEM`,
    `Look: ${p.design.look}`,
    `Colors: background ${p.design.colors.background}, surface ${p.design.colors.surface}, primary ${p.design.colors.primary}, accent ${p.design.colors.accent}.`,
    `Font: ${p.design.font}.`,
    ``,
    `PAGES`,
    pages,
    ``,
    `MUST-HAVE FEATURES (all of them, fully working — no placeholders, no TODOs):`,
    features,
    should.length ? `\nNICE-TO-HAVE (only if everything above is done): ${should.map((f) => f.name).join(", ")}` : ``,
    p.superiority.length ? `\nCOMPETITIVE EDGES (each edge is a feature; research found these gaps in the market):\n${edges}` : ``,
    p.edgeCases.length ? `\nEDGE CASES to handle explicitly: ${p.edgeCases.join("; ")}` : ``,
    ``,
    `QUALITY BAR (verification will test all of it on the live URL):`,
    `- ${p.qualityBar.join("\n- ")}`,
    ``,
    `RULES: production build must pass. No external network calls at runtime. Accessible labels on every control. No dead links. Include a README.md and .env.example (may be empty).`,
  ].join("\n");
}

export async function engineerPrompt(
  idea: string,
  brief: ResearchBrief,
  spec: ProductSpec,
  plan: PlanId,
  emit: Emit,
): Promise<MasterBuildPrompt> {
  const started = Date.now();
  await emit({ kind: "command", line: `$ lastmile prompt — engineering the master build prompt` });

  let parsed: Omit<MasterBuildPrompt, "instructions" | "model" | "providerLabel" | "tokens" | "elapsedMs"> | null = null;
  let model: string | null = null;
  let providerLabel: string | null = null;
  let tokens = 0;

  try {
    await emit({ kind: "info", line: "-> distilling the research brief into a build contract" });
    const res = await agentChat(
      plan,
      AGENT,
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildUserPrompt(idea, brief, spec) },
      ],
      { temperature: 0.4, maxTokens: 4000, json: true, timeoutMs: 90_000 },
    );
    tokens = res.tokens;
    model = res.model;
    providerLabel = res.providerLabel;
    await emit({ kind: "info", line: `-> draft ready (${res.providerLabel} ${res.model}, ${res.tokens} tokens)` });

    const json = extractJson<Record<string, unknown>>(res.text);
    if (!json) throw new Error("model returned no parseable JSON");
    parsed = coerce(json, idea, spec);
    if (parsed.features.length === 0) throw new Error("no usable features in the draft");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await emit({ kind: "warn", line: "-> prompt model unavailable (" + msg.slice(0, 120) + ") — assembling from the approved spec" });
    parsed = coerce({}, idea, spec);
  }

  // the superiority checklist has a floor: spec edges backfill a short draft
  if (parsed.superiority.length < 10) {
    const fromSpec = spec.flows.map((f) => f.name + " works end-to-end, no account required");
    const fromResearch = brief.competitors.flatMap((c) => c.gaps.map((g) => `${g} (competitor: ${c.name})`));
    const pool = [...new Set([...fromResearch, ...fromSpec, "Loads in under 2s with zero console errors"])];
    for (const edge of pool) {
      if (parsed.superiority.length >= 10) break;
      if (!parsed.superiority.includes(edge)) parsed.superiority.push(edge);
    }
  }

  const instructions = assembleInstructions(parsed);
  const master: MasterBuildPrompt = {
    ...parsed,
    instructions,
    model,
    providerLabel,
    tokens,
    elapsedMs: Date.now() - started,
  };

  await emit({
    kind: "success",
    line: `-> master build prompt ready — ${master.features.length} features, ${master.superiority.length} competitive edges`,
  });
  await emit({ kind: "info", line: `-> product name: ${master.productName} — "${master.tagline.slice(0, 90)}"` });
  return master;
}
