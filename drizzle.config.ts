import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

/* Migrations are generated from lib/schema.ts, not hand-written, so the SQL can
   never drift from the types the app compiles against.

     npm run db:generate   → writes a new file into drizzle/
     npm run db:migrate    → applies anything not yet applied

   The schema name inside lib/schema.ts means the generated SQL targets
   `lastmile.*` and never touches the tables the previous build left in
   `public`. */

config({ path: ".env.local", quiet: true });

export default defineConfig({
  schema: "./lib/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  schemaFilter: ["lastmile"],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
