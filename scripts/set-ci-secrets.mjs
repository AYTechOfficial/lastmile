#!/usr/bin/env node
/* Push the platform credentials into the repo's GitHub Actions secrets.

   The runner executes on an ephemeral CI machine with no access to .env.local,
   so every value it needs has to live as a repository secret. This uploads them
   from the local env file, so rotating a key means editing one place and
   re-running one command.

     node scripts/set-ci-secrets.mjs [owner/repo]

   GitHub requires each secret to be encrypted with the repository's public key
   using a libsodium sealed box — so this needs `libsodium-wrappers`, and it is
   the only reason that dependency exists.

   Secrets are never printed. Only the names and their outcome are reported. */

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const token = process.env.GITHUB_TOKEN?.trim();
if (!token) {
  console.error("GITHUB_TOKEN is not set in .env.local");
  process.exit(1);
}

const repo = process.argv[2]?.trim() || process.env.RUNNER_REPO?.trim() || "AYTechOfficial/lastmile";

/* Local env name → the name the workflow reads it as.
   PLATFORM_GITHUB_TOKEN avoids colliding with the GITHUB_TOKEN that Actions
   injects into every run by itself. */
const MAPPING = {
  DATABASE_URL: "DATABASE_URL",
  AUTH_SECRET: "AUTH_SECRET",
  GROQ_API_KEY: "GROQ_API_KEY",
  GEMINI_API_KEY: "GEMINI_API_KEY",
  NVIDIA_API_KEY: "NVIDIA_API_KEY",
  TAVILY_API_KEY: "TAVILY_API_KEY",
  BROWSER_USE_API_KEY: "BROWSER_USE_API_KEY",
  GITHUB_TOKEN: "PLATFORM_GITHUB_TOKEN",
  VERCEL_TOKEN: "VERCEL_TOKEN",
  VERCEL_TEAM_ID: "VERCEL_TEAM_ID",
  RENDER_API_KEY: "RENDER_API_KEY",
};

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "lastmile",
  "Content-Type": "application/json",
};

const sodium = (await import("libsodium-wrappers")).default;
await sodium.ready;

const keyRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/public-key`, {
  headers,
});
if (!keyRes.ok) {
  console.error(`Could not read the repo public key (HTTP ${keyRes.status}). Does the PAT have repo admin?`);
  process.exit(1);
}
const { key, key_id } = await keyRes.json();

function encrypt(value) {
  const binKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  const binSecret = sodium.from_string(value);
  const sealed = sodium.crypto_box_seal(binSecret, binKey);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

let set = 0;
let skipped = 0;
let failed = 0;

for (const [localName, secretName] of Object.entries(MAPPING)) {
  const value = process.env[localName]?.trim();
  if (!value) {
    console.log(`  --    ${secretName.padEnd(22)} not present locally, skipped`);
    skipped++;
    continue;
  }

  const res = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/${secretName}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ encrypted_value: encrypt(value), key_id }),
  });

  if (res.status === 201 || res.status === 204) {
    console.log(`  OK    ${secretName.padEnd(22)} set`);
    set++;
  } else {
    console.log(`  FAIL  ${secretName.padEnd(22)} HTTP ${res.status} ${(await res.text()).slice(0, 90)}`);
    failed++;
  }
}

console.log(`\n${set} set, ${skipped} skipped, ${failed} failed — on ${repo}`);
process.exit(failed > 0 ? 1 : 0);
