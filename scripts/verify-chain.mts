/* Print the real provider failover order with the keys that are actually set.
   This is the honest answer to "why is Groq being used": either it is the only
   keyed provider left, or the priority field is broken. */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

const { resolveProviders } = await import("../lib/platform/settings");

const tier = process.argv[2] === "pro" ? "premium" : "free";
const providers = await resolveProviders(tier as "free" | "premium");

console.log(`failover order for the ${tier} tier (priority, high first):`);
for (const p of providers) {
  console.log(`  ${String(p.priority).padStart(3)}  ${p.label.padEnd(20)} ${p.models.length} model(s)  lead: ${p.models[0]}`);
}
if (providers.length === 0) {
  console.log("  (none — no key resolves for this tier)");
}