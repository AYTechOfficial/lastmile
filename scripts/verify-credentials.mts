/* Verify the credential layer.

     npx tsx scripts/verify-credentials.mts

   Two halves:

     1. Every configured platform default is probed against its real service.
        A key that is present but dead is worse than a missing one, because it
        fails later, inside a run, wearing the costume of a pipeline bug.

     2. The resolution rules are proven:
          · a user's own key wins over the platform default
          · removing it falls back to the platform default
          · a NORMAL USER never receives a platform key, masked or otherwise
          · a user never receives another user's key
          · only an operator view describes the platform's own credentials

   Nothing here prints a secret. Probes are read-only. */

import { config } from "dotenv";
import { sql as raw } from "drizzle-orm";

config({ path: ".env.local", quiet: true });

const { db, client } = await import("../lib/db");
const { SERVICES, resolveServiceCredential, setUserCredential, clearUserCredential, userServiceViews, adminServiceViews } =
  await import("../lib/platform/services");
const { probeService } = await import("../lib/platform/probe");

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${label}${detail ? " — " + detail : ""}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
  }
}

const accounts = (await db.execute(
  raw`select id, email from lastmile."user" order by created_at`,
)) as unknown as { id: string; email: string }[];

if (accounts.length < 2) {
  console.error("Need two accounts in lastmile.user — run `node scripts/db-seed.mjs`.");
  process.exit(1);
}

const [userA, userB] = accounts;

/* ── 1. do the platform defaults actually work? ──────────────────────────── */
console.log("\n1. platform defaults, probed live");

for (const def of SERVICES) {
  const value = process.env[def.envVar]?.trim();
  if (!value) {
    console.log(`  --    ${def.label.padEnd(20)} not configured (${def.envVar})`);
    continue;
  }
  const result = await probeService(def.id, value);
  const detail = result.label
    ? `${result.label}${result.detail ? " · " + result.detail : ""}`
    : (result.detail ?? "");
  check(`${def.label} default works`, result.ok, detail);
}

/* ── 2. a user's own key wins ────────────────────────────────────────────── */
console.log("\n2. precedence: the user's own key over the platform default");

const before = await resolveServiceCredential(userA.id, "vercel");
check("falls back to the platform default initially", before.source === "platform", `source=${before.source}`);

const ownKey = "vcp_test-value-that-is-never-sent-anywhere";
await setUserCredential(userA.id, "vercel", ownKey, "test account");

const during = await resolveServiceCredential(userA.id, "vercel");
check("user's own key takes precedence", during.source === "user", `source=${during.source}`);
check("the exact stored value is returned", during.value === ownKey);
check("and it differs from the platform default", during.value !== before.value);

/* A second user must be unaffected by the first user's override. */
const other = await resolveServiceCredential(userB.id, "vercel");
check("another user still gets the platform default", other.source === "platform", `source=${other.source}`);
check("another user never sees the first user's key", other.value !== ownKey);

/* Replacing an existing key exercises the upsert. Its conflict target is a
   COMPOSITE of (user_id, service), which only matches the unique index if the
   column list is exactly right — a mistake here throws the first time a user
   updates a key rather than the first time they set one. */
const replacement = "vcp_replacement-value-also-never-sent";
let upsertError: string | null = null;
try {
  await setUserCredential(userA.id, "vercel", replacement, "renamed account");
} catch (error) {
  upsertError = error instanceof Error ? error.message : String(error);
}
check("replacing an existing key does not throw", upsertError === null, upsertError ?? "");

const [{ n: rowsForA }] = (await db.execute(
  raw`select count(*)::int as n from lastmile.user_credentials where user_id = ${userA.id}`,
)) as unknown as { n: number }[];
check("replacing updates in place instead of inserting a second row", rowsForA === 1, `${rowsForA} rows`);

const replaced = await resolveServiceCredential(userA.id, "vercel");
check("the replacement value is what resolves", replaced.value === replacement);

/* ── 3. what a normal user is shown ──────────────────────────────────────── */
console.log("\n3. what a normal user can see");

const views = await userServiceViews(userA.id);
const ownView = views.find((v) => v.id === "vercel")!;
const platformView = views.find((v) => v.id === "github")!;

check("the user's own service reports source=user", ownView.source === "user");
check("and is masked, not echoed", Boolean(ownView.keyMask) && !ownView.keyMask!.includes(ownKey));
check(
  "a platform-provided service reports source=platform",
  platformView.source === "platform",
  platformView.source ?? "null",
);
check(
  "and reveals NO key information at all",
  platformView.keyMask === null && platformView.label_ === null,
);
check(
  "no view anywhere contains a platform key value",
  views.every((v) => !v.keyMask || !Object.values(process.env).includes(v.keyMask)),
);

/* ── 4. what an operator is shown ────────────────────────────────────────── */
console.log("\n4. what an operator can see");

const admin = await adminServiceViews();
const adminGithub = admin.find((s) => s.id === "github")!;
const realToken = process.env.GITHUB_TOKEN ?? "";

check("the admin view reports the platform default as configured", adminGithub.configured);
check("with a mask", Boolean(adminGithub.keyMask), adminGithub.keyMask ?? "null");
check("but never the value itself", adminGithub.keyMask !== realToken);
check("and says where it comes from", adminGithub.from === "env" || adminGithub.from === "settings", adminGithub.from ?? "null");

/* ── 5. removing a key restores the fallback ─────────────────────────────── */
console.log("\n5. disconnecting restores the platform default");

await clearUserCredential(userA.id, "vercel");
const after = await resolveServiceCredential(userA.id, "vercel");
check("resolution falls back again", after.source === "platform", `source=${after.source}`);

const [{ n: leftover }] = (await db.execute(
  raw`select count(*)::int as n from lastmile.user_credentials where user_id = ${userA.id}`,
)) as unknown as { n: number }[];
check("no test credentials left behind", leftover === 0, `${leftover} rows`);

await client.end();

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
