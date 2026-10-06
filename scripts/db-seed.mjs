#!/usr/bin/env node
/* Provision the agent QA account in the new schema.

   The `lastmile` schema is separate from the tables the previous build left in
   `public`, so accounts do not carry over automatically. This copies the
   existing QA account across with its password hash intact — the same
   credentials keep working — and, separately, creates an agent account whose
   password is recorded in .env.local rather than printed here.

     node scripts/db-seed.mjs

   Safe to re-run: existing emails are left alone. */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { config } from "dotenv";
import bcrypt from "bcryptjs";
import postgres from "postgres";

config({ path: ".env.local", quiet: true });

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is not set in .env.local");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 15 });

/* The account built for automated work. It is an operator, so it can reach
   /admin and drive every stage. */
const AGENT_EMAIL = process.env.QA_AGENT_EMAIL?.trim() || "agent@lastmile.dev";

function setEnvLocal(key, value) {
  const path = ".env.local";
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(current)
    ? current.replace(pattern, line)
    : current.replace(/\n?$/, "\n") + line + "\n";
  writeFileSync(path, next);
}

try {
  /* 1. Carry the existing QA account across, hash and all. */
  const [qa] = await sql`
    select id, name, email, password_hash, image
      from public."user"
     where email = 'qa@lastmile.dev'
     limit 1
  `;

  if (qa?.password_hash) {
    const inserted = await sql`
      insert into lastmile."user" (id, name, email, password_hash, image, plan)
      values (${qa.id}, ${qa.name}, ${qa.email}, ${qa.password_hash}, ${qa.image}, 'pro')
      on conflict (email) do nothing
      returning email
    `;
    console.log(
      inserted.length
        ? `copied ${qa.email} into lastmile.user (plan=pro, same password)`
        : `${qa.email} already present in lastmile.user`,
    );
  } else {
    console.log("no qa@lastmile.dev in public.user — skipping the copy");
  }

  /* 2. The agent account. The password is generated, hashed, and written to
        .env.local so it is available to scripts without ever being echoed. */
  const [existingAgent] = await sql`
    select id from lastmile."user" where email = ${AGENT_EMAIL} limit 1
  `;

  if (existingAgent) {
    console.log(`${AGENT_EMAIL} already present in lastmile.user`);
  } else {
    const password = randomBytes(18).toString("base64url");
    const passwordHash = await bcrypt.hash(password, 10);

    await sql`
      insert into lastmile."user" (name, email, password_hash, plan)
      values ('Agent QA', ${AGENT_EMAIL}, ${passwordHash}, 'pro')
    `;

    setEnvLocal("QA_AGENT_EMAIL", AGENT_EMAIL);
    setEnvLocal("QA_AGENT_PASSWORD", password);
    console.log(`created ${AGENT_EMAIL} (plan=pro); password stored in .env.local`);
  }

  /* 3. Report what exists now, so the operator can see the state at a glance. */
  const rows = await sql`
    select email, plan from lastmile."user" order by created_at
  `;
  console.log(`\nlastmile.user now holds ${rows.length} account(s):`);
  for (const r of rows) console.log(`  ${r.email}  plan=${r.plan}`);

  console.log(
    "\nReminder: /admin is gated by ADMIN_EMAILS in .env.local, which currently lists " +
      (process.env.ADMIN_EMAILS ?? "(nothing)"),
  );
} catch (error) {
  console.error("seed failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
