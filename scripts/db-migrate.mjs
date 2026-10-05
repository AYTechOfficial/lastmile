/* Apply every .sql file in drizzle/ in name order.
   Each file must be idempotent — this runner keeps no migration ledger, so a
   file that has already run may run again. That trade keeps the repo free of a
   migrations table while the schema is still moving quickly.

   Usage: node scripts/db-migrate.mjs                                */

import { readdirSync, readFileSync } from "node:fs";
import { config } from "dotenv";
import postgres from "postgres";

config({ path: ".env.local" });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set — check .env.local");
  process.exit(1);
}

const files = readdirSync("drizzle")
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.log("no migrations found in drizzle/");
  process.exit(0);
}

const sql = postgres(url, { prepare: false, max: 1 });

try {
  for (const file of files) {
    const body = readFileSync(`drizzle/${file}`, "utf8");
    process.stdout.write("→ " + file + " ... ");
    await sql.unsafe(body);
    console.log("ok");
  }
  console.log("\ndatabase is up to date.");
} catch (err) {
  console.error("\nmigration failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
