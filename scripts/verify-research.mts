/* Live check of the search chain and the research agent.

   This is the test that matters for the reported bug: it runs the real chain
   against the real network and prints what each rung did, so "search never
   fails a run" is a measurement rather than a claim.

     npx tsx scripts/verify-research.mts            # search chain only
     npx tsx scripts/verify-research.mts --agent    # + the full research agent
     npx tsx scripts/verify-research.mts --agent --model gemini-2.5-flash */

import { config } from "dotenv";
import type { ResearchBrief } from "../lib/domain";

config({ path: ".env.local", quiet: true });

const args = process.argv.slice(2);
const withAgent = args.includes("--agent");
const modelArg = args.includes("--model") ? args[args.indexOf("--model") + 1] : null;

const { webSearch } = await import("../lib/ai/search");
const { planOf } = await import("../lib/plans");

const SENTENCE = "An invoice generator for freelancers";
const QUERIES = [
  "invoice generator for freelancers software competitors",
  "invoice generator pricing plans",
  "freelance invoicing market size growth",
];

let failures = 0;

console.log("=== search chain ===");
for (const query of QUERIES) {
  const started = Date.now();
  const outcome = await webSearch(query, { max: 5, budgetMs: 30_000 });
  const ms = Date.now() - started;

  console.log(`\nquery: ${query}`);
  console.log(`  ${outcome.hits.length} hit(s) via ${outcome.provider} in ${ms}ms`);
  for (const attempt of outcome.attempts) {
    console.log(
      `    ${attempt.ok ? "ok  " : "fail"} ${attempt.provider.padEnd(12)} ${attempt.count} hit(s)${
        attempt.detail ? " — " + attempt.detail : ""
      }`,
    );
  }
  for (const hit of outcome.hits.slice(0, 3)) {
    console.log(`    · ${hit.host} — ${hit.title.slice(0, 64)}`);
  }
  if (outcome.degradedReason) console.log(`  degraded: ${outcome.degradedReason}`);

  /* The whole point: a query must always come back with an answer, even when
     every provider is unreachable, and it must not take longer than its slice. */
  if (outcome.provider === "none") {
    console.log("  !! no provider answered — this would have failed the stage");
    failures++;
  }
  if (ms > 35_000) {
    console.log(`  !! exceeded its budget slice (${ms}ms)`);
    failures++;
  }
}

if (!withAgent) {
  console.log(`\n${failures === 0 ? "search chain ok" : failures + " search problem(s)"}`);
  process.exit(failures === 0 ? 0 : 1);
}

console.log("\n=== research agent ===");
const plan = planOf("free");
const events: string[] = [];

const { runResearch } = await import("../lib/agents/research");

const started = Date.now();
const result = await runResearch({
  sentence: SENTENCE,
  plan,
  userId: null,
  preferredModel: modelArg,
  emit: async (kind, line) => {
    events.push(`[${kind}] ${line}`);
    console.log(`  ${kind.padEnd(7)} ${line}`);
  },
  heartbeat: async () => {},
  budgetMs: 5 * 60_000,
});

const brief: ResearchBrief = result.brief;

console.log("\n--- brief ---");
console.log(`quality:       ${brief.quality}`);
console.log(`usable:        ${result.usable}`);
console.log(`model:         ${brief.providerLabel ?? "none"} / ${brief.model ?? "none"}`);
console.log(`search:        ${brief.searchProvider}`);
console.log(`sources:       ${brief.sources.length}`);
console.log(`competitors:   ${brief.competitors.length}`);
console.log(`confidence:    ${brief.confidence}`);
console.log(`tokens:        ${result.tokens}`);
console.log(`elapsed:       ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`degradedReason:${brief.degradedReason ?? " (none)"}`);

if (brief.competitors.length > 0) {
  console.log("competitors:");
  for (const c of brief.competitors.slice(0, 5)) {
    console.log(`  · ${c.name} — ${c.url}`);
  }
}
if (brief.flows.length > 0) {
  console.log("flows:");
  for (const f of brief.flows.slice(0, 4)) {
    console.log(`  · ${f.name} (${f.criteria.length} criteria)`);
  }
}

/* The agent's contract: it always yields a brief, and it always tells the truth
   about how it was built. Both are asserted here. */
if (!result.usable) {
  console.log("\n!! the agent reported the brief as unusable");
  failures++;
}
if (!brief.quality) {
  console.log("\n!! the brief has no quality label");
  failures++;
}
if (brief.quality === "full" && brief.sources.length === 0) {
  console.log("\n!! the brief claims full quality with no sources — that is the dishonest case");
  failures++;
}

console.log(`\n${failures === 0 ? "research agent ok" : failures + " problem(s)"}`);
process.exit(failures === 0 ? 0 : 1);
