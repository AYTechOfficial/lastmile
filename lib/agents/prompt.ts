/* The Prompt Agent (the Prompt Engineer).

   The Research Agent answers "is this worth building and for whom". This one
   answers "what exactly do we build", and turns that into the single contract
   the Coding Agent will be held to. It produces two artifacts:

     1. ProductSpec   — the machine-checkable shape: routes, data model, flows,
                        and the acceptance criteria the Verifier will assert.
     2. MasterBuildPrompt — the assembled prose the coder receives verbatim,
                        plus the design system and the quality bar.

   Like the Research Agent, this one cannot fail a run. It sits between the
   evidence and the build, and a model outage here must not throw away research
   that already cost real time and tokens. So it degrades the same way:

     · A model answers  → a spec written from the brief, then the master prompt
                          assembled from that spec.
     · No model answers → the spec is derived deterministically from the brief's
                          own flows and stack. Coarser, still buildable, and the
                          run log says which happened.

   The split matters: the spec is a *contract*, so the deterministic fallback
   still produces a valid one — it just leans on what research already found
   rather than inventing a better interpretation of it. */

import type {
  DesignSystem,
  FeatureSpec,
  MasterBuildPrompt,
  PageSpec,
  ProductSpec,
  ResearchBrief,
} from "../domain";
import { chat, chatJson, defaultModelFor, type ChatInput } from "../ai/chat";
import type { PlanConfig } from "../plans";

export type PromptInput = {
  sentence: string;
  brief: ResearchBrief | null;
  plan: PlanConfig;
  userId: string | null;
  preferredModel?: string | null;
  /** checkpoint variant — incremented when a human asks for changes */
  variant: number;
  /** the human's note when they asked for changes */
  guidance?: string | null;
  emit: (kind: "info" | "command" | "success" | "warn" | "error" | "url", line: string) => Promise<void>;
  heartbeat: () => Promise<void>;
};

export type PromptResult = {
  spec: ProductSpec;
  master: MasterBuildPrompt;
  tokens: number;
  /** false only when there is nothing at all to build from */
  usable: boolean;
  reason?: string;
};

const PRODUCT_NAME_MAX = 60;

export async function runPrompt(input: PromptInput): Promise<PromptResult> {
  const started = Date.now();
  const { sentence, brief } = input;

  await input.emit("command", `$ lastmile prompt --variant ${input.variant}`);
  if (input.guidance) await input.emit("info", `change request: ${input.guidance}`);

  /* ————— 1. the spec ————— */

  const specAsk = await askSpec(input);
  let spec = specAsk.spec;
  let degradedReason: string | null = null;

  if (!spec) {
    await input.emit(
      "warn",
      `no model answered (${specAsk.reason ?? "chain exhausted"}) — deriving the spec from the research brief`,
    );
    spec = specFromBrief(sentence, brief, input.variant);
    degradedReason = specAsk.reason ?? "the spec was derived without a model";
  } else {
    spec = { ...spec, variant: input.variant };
    await input.emit(
      "success",
      `spec ready — ${spec.routes.length} route(s), ${spec.flows.length} flow(s), ${spec.acceptance} acceptance check(s)`,
    );
  }

  await input.heartbeat();

  /* ————— 2. the master prompt ————— */

  const prose = await askInstructions(input, spec);
  const master = assembleMasterPrompt({
    sentence,
    spec,
    brief,
    instructions: prose.text,
    providerLabel: prose.providerLabel,
    model: prose.model,
    tokens: specAsk.tokens + prose.tokens,
    elapsedMs: Date.now() - started,
    degradedReason,
  });

  await input.emit(
    "success",
    `master prompt assembled — ${master.features.length} feature(s), ${master.pages.length} page(s), ${master.edgeCases.length} edge case(s)`,
  );

  return {
    spec,
    master,
    tokens: specAsk.tokens + prose.tokens,
    usable: true,
  };
}

/* ————————————————————————— the spec, from a model ————————————————————————— */

const SPEC_SHAPE = `{
  "title": "the product's name",
  "summary": "two sentences on what it does and for whom",
  "positioning": "the market position, taken from the research",
  "gap": "the opening it can own, taken from the research",
  "audience": ["who uses it"],
  "stack": ["next.js", "react", "tailwind", "client-side state only"],
  "flows": [{ "name": "a user flow", "criteria": ["a testable assertion"] }],
  "dataModel": [{ "table": "name", "columns": ["id", "name", "created_at"] }],
  "routes": [{ "path": "/", "purpose": "what this page does" }],
  "scope": { "in": ["what v1 includes"], "out": ["what v1 deliberately excludes"] },
  "risks": ["what could go wrong"],
  "productionChecklist": ["what must be true before this is real"]
}`;

async function askSpec(
  input: PromptInput,
): Promise<{ spec: ProductSpec | null; tokens: number; reason: string | null }> {
  const { brief } = input;

  const evidence = brief
    ? [
        `idea: ${brief.idea}`,
        `positioning: ${brief.positioning}`,
        `gap: ${brief.gap}`,
        `audience: ${brief.audience.join(", ") || "unstated"}`,
        `competitors: ${brief.competitors.map((c) => `${c.name} (${c.url}) — ${c.what}`).join("; ") || "none found"}`,
        `saturation: ${brief.saturation.level} — ${brief.saturation.evidence.join("; ")}`,
        `profit: ${brief.profit.model} — ${brief.profit.verdict}`,
        `suggested changes: ${brief.changes.map((c) => `${c.before} → ${c.after} (${c.why})`).join("; ") || "none"}`,
        `research quality: ${brief.quality} (confidence ${brief.confidence})`,
        `research flows already proposed: ${brief.flows.map((f) => `${f.name}: ${f.criteria.join(" | ")}`).join("; ") || "none"}`,
      ].join("\n")
    : "no research brief is available — design conservatively from the sentence alone";

  const chatInput: ChatInput = {
    tier: input.plan.modelTier,
    userId: input.userId,
    agent: "spec",
    preferred: input.preferredModel ?? defaultModelFor(input.plan.modelTier),
    timeoutMs: 120_000,
    maxRungs: 10,
    onAttempt: async (attempt) => {
      await input.emit(
        attempt.ok ? "success" : "warn",
        `  model ${attempt.provider}/${attempt.model} ${attempt.ok ? "answered" : `failed (${attempt.detail ?? "unknown"})`} in ${Math.round(attempt.ms / 1000)}s`,
      );
    },
  };

  const { value, result } = await chatJson<Partial<ProductSpec>>(chatInput, [
    { role: "system", content: "You are a product spec writer. You write the smallest spec that fully covers the flows." },
    {
      role: "user",
      content: `The user asked for: "${input.sentence}"

RESEARCH
${evidence}

${input.guidance ? `THE HUMAN ASKED FOR THESE CHANGES AT THE CHECKPOINT: ${input.guidance}\n` : ""}
Write the product spec. Rules:
- Every flow needs acceptance criteria that a browser test could assert against a live URL. "It works" is not a criterion; "the item appears in the list after reload" is.
- The stack is always a client-side React app — there is no backend in the generated product, so no server routes and no database.
- scope.out is as important as scope.in: say what v1 will NOT do.
- Reply with ONLY a JSON object of this shape:

${SPEC_SHAPE}`,
    },
  ]);

  if (!result.ok || !value) {
    return { spec: null, tokens: result.tokens, reason: result.reason ?? "the model did not return a spec" };
  }

  return { spec: normalizeSpec(value, input.sentence, input.variant), tokens: result.tokens, reason: null };
}

/* ————————————————————————— the master prompt prose ————————————————————————— */

async function askInstructions(
  input: PromptInput,
  spec: ProductSpec,
): Promise<{ text: string; providerLabel: string | null; model: string | null; tokens: number }> {
  const chatInput: ChatInput = {
    tier: input.plan.modelTier,
    userId: input.userId,
    agent: "prompt",
    preferred: input.preferredModel ?? defaultModelFor(input.plan.modelTier),
    timeoutMs: 120_000,
    maxRungs: 10,
  };

  /* `chat`, not `chatJson`: this is prose by design, so asking for JSON would
     trigger a pointless parse-and-retry round and, worse, discard the model
     attribution that says which provider wrote the contract. */
  const result = await chat(chatInput, [
    {
      role: "system",
      content:
        "You are a prompt engineer. You write the single instruction document a coding agent follows to build a product.",
    },
    {
      role: "user",
      content: `Write the build instructions for this product.

NAME: ${spec.title}
SUMMARY: ${spec.summary}
STACK: ${spec.stack.join(", ")}
ROUTES: ${spec.routes.map((r) => `${r.path} — ${r.purpose}`).join("; ")}
FLOWS: ${spec.flows.map((f) => `${f.name}: ${f.criteria.join(" | ")}`).join("; ")}
DATA MODEL: ${spec.dataModel.map((t) => `${t.table}(${t.columns.join(", ")})`).join("; ")}
IN SCOPE: ${spec.scope.in.join("; ")}
OUT OF SCOPE: ${spec.scope.out.join("; ")}

Write plain prose — the actual brief a developer would follow. Cover, in order:
1. What is being built and the one thing it must do better than the alternatives.
2. The design language: exact colour values, one font, the spacing rhythm, and what the empty state looks like.
3. Each page and what a person sees and can do on it.
4. The data model and how state persists between reloads.
5. The edge cases that must not break: empty lists, very long text, a reload mid-flow, a failed action.
6. The quality bar: what would make this look unfinished.

Be specific and imperative. Do not include JSON. Reply with the instructions only.`,
    },
  ]);

  if (!result.ok || !result.text.trim()) {
    /* The prose is the nice-to-have; the spec is the contract. Fall back to
       instructions assembled from the spec rather than failing the stage. */
    return {
      text: instructionsFromSpec(spec),
      providerLabel: null,
      model: null,
      tokens: result.tokens,
    };
  }

  return {
    text: result.text.trim(),
    providerLabel: result.providerLabel,
    model: result.model,
    tokens: result.tokens,
  };
}

/* ————————————————————————— assembly ————————————————————————— */

/** A fixed, defensible design system. Not model-generated on purpose: the look
    is a product decision, and letting a model re-pick it per run produces
    inconsistent output and an unpredictable quality bar. */
const DESIGN: DesignSystem = {
  look: "dark, dense, engineering-tool aesthetic — monospace for data, a single accent colour, no gradients on content surfaces",
  colors: {
    background: "#0b0d10",
    surface: "#14171c",
    primary: "#e6e9ef",
    accent: "#4f8cff",
  },
  font: "Inter for UI, JetBrains Mono for numbers and ids",
};

function assembleMasterPrompt(args: {
  sentence: string;
  spec: ProductSpec;
  brief: ResearchBrief | null;
  instructions: string;
  providerLabel: string | null;
  model: string | null;
  tokens: number;
  elapsedMs: number;
  degradedReason: string | null;
}): MasterBuildPrompt {
  const { spec, brief } = args;

  const pages: PageSpec[] = spec.routes.map((route) => ({
    path: route.path,
    purpose: route.purpose,
    /* Sections are derived from the flows that land on this route, so a page
       is never described as empty in the contract. */
    sections: sectionsForRoute(route.path, spec),
  }));

  const features: FeatureSpec[] = spec.flows.map((flow) => ({
    name: flow.name,
    description: flow.criteria.join("; "),
    priority: "must",
  }));

  const superiority = [
    ...(brief?.gap ? [brief.gap] : []),
    ...(brief?.changes ?? []).slice(0, 3).map((c) => c.after),
    ...(spec.positioning ? [spec.positioning] : []),
  ].filter(Boolean);

  const edgeCases = [
    "An empty list must show a purposeful empty state, never a blank panel",
    "Text longer than 200 characters must not break the layout",
    "A reload mid-flow must not lose what was already saved",
    "A failed action must say what failed and leave the UI usable",
    ...spec.risks.slice(0, 3),
  ];

  const qualityBar = [
    "No placeholder text, no lorem ipsum, no TODOs left in the shipped UI",
    "Every interactive control has a visible focus state",
    "Numbers and ids use a monospace face so columns align",
    "The first screen is usable with no account and no data",
    ...spec.productionChecklist.slice(0, 3),
  ];

  const productName = titleCase(spec.title || args.sentence).slice(0, PRODUCT_NAME_MAX);

  const header = [
    `# ${productName}`,
    "",
    spec.summary,
    "",
    `Stack: ${spec.stack.join(", ")}`,
    `Data: client-side only — the generated product has no backend.`,
    args.degradedReason ? `\nNOTE: ${args.degradedReason}. Build conservatively.` : "",
    "",
    "---",
    "",
  ].join("\n");

  return {
    productName,
    tagline: spec.positioning || spec.summary,
    stack: spec.stack,
    dataMode: "client",
    design: DESIGN,
    pages,
    features,
    superiority,
    edgeCases,
    qualityBar,
    instructions: header + args.instructions,
    model: args.model,
    providerLabel: args.providerLabel,
    tokens: args.tokens,
    elapsedMs: args.elapsedMs,
  };
}

function sectionsForRoute(path: string, spec: ProductSpec): string[] {
  const lower = path.toLowerCase();
  const sections: string[] = [];

  for (const flow of spec.flows) {
    const name = flow.name.toLowerCase();
    /* A flow belongs to a page when the words overlap — crude, deterministic,
       and good enough to stop a page from being described as empty. */
    const words = name.split(/\s+/).filter((w) => w.length > 3);
    if (words.some((w) => lower.includes(w)) || (path === "/" && sections.length === 0)) {
      sections.push(flow.name);
    }
  }

  if (sections.length === 0) sections.push("Primary content and the main call to action");
  return [...new Set(sections)].slice(0, 5);
}

function instructionsFromSpec(spec: ProductSpec): string {
  return [
    `Build ${spec.title}.`,
    "",
    spec.summary,
    "",
    "Pages:",
    ...spec.routes.map((r) => `- ${r.path} — ${r.purpose}`),
    "",
    "Flows that must work:",
    ...spec.flows.map((f) => `- ${f.name}: ${f.criteria.join("; ")}`),
    "",
    "Data (client-side, persisted across reloads):",
    ...spec.dataModel.map((t) => `- ${t.table}: ${t.columns.join(", ")}`),
    "",
    "In scope:",
    ...spec.scope.in.map((s) => `- ${s}`),
    "",
    "Out of scope:",
    ...spec.scope.out.map((s) => `- ${s}`),
    "",
    `Design: ${DESIGN.look}. Background ${DESIGN.colors.background}, surface ${DESIGN.colors.surface}, primary ${DESIGN.colors.primary}, accent ${DESIGN.colors.accent}. Font ${DESIGN.font}.`,
  ].join("\n");
}

/* ————————————————————————— the deterministic spec ————————————————————————— */

/** Derive a spec from the brief with no model. The brief already carries flows
    and a stack from research, so this is a re-shaping rather than an invention —
    which is exactly why it can be trusted as a fallback contract. */
function specFromBrief(sentence: string, brief: ResearchBrief | null, variant: number): ProductSpec {
  const flows =
    brief && brief.flows.length > 0
      ? brief.flows
      : [
          { name: "Create an item", criteria: ["the item is saved", "the item appears in the list"] },
          { name: "View the list", criteria: ["saved items are listed", "an empty list shows a next step"] },
        ];

  const routes = [
    { path: "/", purpose: "the main screen: the list and the primary action" },
    { path: "/settings", purpose: "preferences and data management" },
  ];

  return {
    title: titleCase(sentence).slice(0, PRODUCT_NAME_MAX),
    summary: `A client-side tool for: ${sentence}. Built from the research brief without a model, so the scope is deliberately conservative.`,
    positioning: brief?.positioning ?? "",
    gap: brief?.gap ?? "",
    audience: brief?.audience ?? [],
    stack: ["next.js", "react", "tailwind", "client-side state only"],
    flows,
    dataModel: [{ table: "items", columns: ["id", "title", "notes", "created_at"] }],
    routes,
    scope: {
      in: ["Create, list, edit and delete the primary record", "Persist across reloads", "An empty state with a clear next step"],
      out: ["Accounts and authentication", "Server-side storage", "Payments", "Multi-user collaboration"],
    },
    risks: brief?.risks ?? ["The spec was derived without a model, so the flows are generic"],
    productionChecklist: brief?.productionChecklist ?? ["Every flow has a testable acceptance criterion"],
    acceptance: flows.reduce((n, f) => n + f.criteria.length, 0),
    variant,
    origin: "fallback",
  };
}

/* ————————————————————————— normalization ————————————————————————— */

function normalizeSpec(raw: Partial<ProductSpec>, sentence: string, variant: number): ProductSpec {
  const flows = (raw.flows ?? [])
    .map((f) => ({ name: str(f?.name), criteria: strArray(f?.criteria) }))
    .filter((f) => f.name && f.criteria.length > 0);

  const routes = (raw.routes ?? [])
    .map((r) => ({ path: str(r?.path) || "/", purpose: str(r?.purpose) }))
    .filter((r) => r.path.startsWith("/"));

  const dataModel = (raw.dataModel ?? [])
    .map((t) => ({ table: str(t?.table), columns: strArray(t?.columns) }))
    .filter((t) => t.table && t.columns.length > 0);

  /* Guarantee the shape the Verifier and the coder depend on: at least one
     route, one flow with criteria, and one table. A spec missing these would
     produce a build with nothing to check. */
  const safeFlows =
    flows.length > 0
      ? flows
      : [{ name: "Use the product", criteria: ["the main action completes", "the result is visible"] }];
  const safeRoutes = routes.length > 0 ? routes : [{ path: "/", purpose: "the main screen" }];
  const safeModel = dataModel.length > 0 ? dataModel : [{ table: "items", columns: ["id", "title", "created_at"] }];

  return {
    title: str(raw.title) || titleCase(sentence).slice(0, PRODUCT_NAME_MAX),
    summary: str(raw.summary) || sentence,
    positioning: str(raw.positioning),
    gap: str(raw.gap),
    audience: strArray(raw.audience),
    stack: strArray(raw.stack).length > 0 ? strArray(raw.stack) : ["next.js", "react", "tailwind"],
    flows: safeFlows,
    dataModel: safeModel,
    routes: safeRoutes,
    scope: {
      in: strArray(raw.scope?.in),
      out: strArray(raw.scope?.out),
    },
    risks: strArray(raw.risks),
    productionChecklist: strArray(raw.productionChecklist),
    acceptance: safeFlows.reduce((n, f) => n + f.criteria.length, 0),
    variant,
    origin: "research",
  };
}

/* ————————————————————————— helpers ————————————————————————— */

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter(Boolean);
}

function titleCase(value: string): string {
  const clean = value.trim().replace(/\.+$/, "");
  if (!clean) return "Untitled";
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}
