import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

/* Everything in this file lives in its own Postgres schema, not in `public`.

   That is not decoration. The previous build deployed into the same Supabase
   database and left real accounts and runs in `public.user` / `public.runs`.
   Creating the new tables in `public` would have collided with them — either
   failing outright, or silently adopting the old row shape and breaking at
   runtime. Namespacing makes this build additive: the old data is untouched and
   the whole thing is removable with `drop schema lastmile cascade`. */
export const app = pgSchema("lastmile");

/* The data model.

   One architectural rule shapes this file: the dashboard and the pipeline never
   share a process. The dashboard writes rows and reads rows. A runner — GitHub
   Actions today, a VM or a container later — claims `jobs`, does the work, and
   writes its results back. Nothing in the request path ever executes agent code.

   That is the difference between this build and the one that died: the previous
   version ran `npm install` and `next build` inside the request process, which
   is not survivable on any serverless host. */

/* ————————————————————————— auth (Auth.js adapter) ————————————————————————— */

export const users = app.table("user", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { withTimezone: true }),
  image: text("image"),
  passwordHash: text("password_hash"),
  plan: text("plan").notNull().default("free"), // free | pro — gates the model policy

  /** Which GitHub hosts a user's generated code.
   *  auto = their linked account if present, else the platform account. */
  githubHost: text("github_host").notNull().default("auto"), // auto | account | platform
  /** verified GitHub username, shown in Settings — not a secret */
  githubLogin: text("github_login"),
  /** optional Vercel team/scope id the user's deploys should target */
  vercelTeamId: text("vercel_team_id"),
  /** verified Vercel username, shown in Settings after connecting */
  vercelAccount: text("vercel_account"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const accounts = app.table(
  "account",
  {
    userId: uuid("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [primaryKey({ columns: [account.provider, account.providerAccountId] })],
);

export const sessions = app.table("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: uuid("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const verificationTokens = app.table(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

/* ————————————————————————— platform settings ————————————————————————— */

/** Singleton operator settings row (id = "app"). Holds the model policy, the
    provider catalog and the infrastructure tokens — provider keys as
    AES-256-GCM ciphertext, never plaintext. */
export const platformSettings = app.table("platform_settings", {
  id: text("id").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** A user's own credential for a service, as a single generic table rather
    than one column per integration.

    Two reasons it is generic. First, adding a service is then a catalog entry
    instead of a migration. Second — and this is the point — every service needs
    exactly the same rule: a key the user supplied wins, otherwise the platform's
    default is used, and the platform's default is never shown to them. One table
    and one resolver means that rule is implemented once.

    Values are AES-256-GCM ciphertext. The plaintext never leaves the server. */
export const userCredentials = app.table(
  "user_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** github | vercel | render | search | exa | browser */
    service: text("service").notNull(),
    valueEncrypted: text("value_encrypted").notNull(),
    /** the account or scope this credential belongs to, verified on save */
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("user_credentials_user_service").on(t.userId, t.service)],
);

/** A user's OWN model endpoints. A key the user pays for wins over the
    platform's capacity, so these are tried first. */
export const userProviders = app.table("user_providers", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  baseUrl: text("base_url").notNull(),
  keyEncrypted: text("key_encrypted").notNull(),
  models: jsonb("models").notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/* ————————————————————————— runs ————————————————————————— */

export const runs = app.table(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runNumber: integer("run_number").notNull(),

    /** the user's one sentence — the only input this product takes */
    sentence: text("sentence").notNull(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),

    /** queued | running | awaiting_approval | done | failed | stopped */
    status: text("status").notNull().default("queued"),
    /** research | checkpoint | prompt | code | verify | deploy | test */
    currentStage: text("current_stage").notNull().default("research"),
    /** which plan policy governed this run — recorded so old runs stay readable
        after the policy changes */
    planId: text("plan_id").notNull().default("free"),

    /** A model the user picked when starting the run, or null to let the chain
        choose the fastest available. Recorded rather than resolved at start
        time so a run stays reproducible after the catalog changes. */
    modelChoice: text("model_choice"),
    /** A search engine the user picked, or null for the default chain order
        (Tavily → Exa → DuckDuckGo → Wikipedia). */
    searchChoice: text("search_choice"),

    /** ResearchBrief */
    research: jsonb("research"),
    /** ProductSpec */
    spec: jsonb("spec"),
    specVariant: integer("spec_variant").notNull().default(1),
    /** MasterBuildPrompt */
    masterPrompt: jsonb("master_prompt"),
    /** ConformanceReport from the last verify pass */
    conformance: jsonb("conformance"),
    /** TestReport from the last live QA pass */
    testReport: jsonb("test_report"),

    /** quality-loop rounds actually run (code → verify → deploy → test) */
    iterations: integer("iterations").notNull().default(0),
    qualityScore: integer("quality_score"),

    /** where the generated code lives — the repo IS the build workspace */
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    repoUrl: text("repo_url"),
    /** last commit the runner produced, so a later stage resumes exactly there */
    commitSha: text("commit_sha"),
    liveUrl: text("live_url"),
    deployId: text("deploy_id"),

    /** the runner's cursor: which stage is mid-flight and what it was doing */
    pipelineState: jsonb("pipeline_state"),
    killRequested: boolean("kill_requested").notNull().default(false),

    tokens: integer("tokens").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    error: text("error"),

    startedAt: timestamp("started_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("runs_user_number").on(t.userId, t.runNumber)],
);

/* ————————————————————————— the queue ————————————————————————— */

/** One row per stage to execute. This table is the boundary between the
    dashboard and the runner.

    Claiming uses `FOR UPDATE SKIP LOCKED`, so several runners can pull work
    concurrently without ever stepping on each other. A runner that dies mid-job
    stops heartbeating and the job is reclaimed by the next runner — which is why
    the previous "fire-and-forget inside the web process" design is gone. */
export const jobs = app.table(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** research | prompt | code | verify | deploy | test */
    kind: text("kind").notNull(),
    /** queued | running | done | failed | dead | cancelled */
    status: text("status").notNull().default("queued"),

    /** higher runs first; the quality loop's fixes outrank fresh runs */
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** earliest time this job may be claimed — how retries back off */
    runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),

    /** which runner holds it, and the lease it must keep alive */
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    leaseMs: integer("lease_ms").notNull().default(15 * 60 * 1000),

    /** stage inputs: the iteration number, the flagged files to re-patch, … */
    payload: jsonb("payload"),
    /** stage outputs the next stage reads */
    result: jsonb("result"),
    error: text("error"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    /* the claim query's exact shape: find the oldest ready job */
    index("jobs_claim_idx").on(t.status, t.runAt, t.priority),
    index("jobs_run_idx").on(t.runId, t.kind),
  ],
);

/* ————————————————————————— the live feed ————————————————————————— */

/** The terminal the dashboard streams. `seq` is allocated per run, and the
    bands keep phases from colliding.

    The timestamps here are when the work actually happened — a runner writes an
    event as it happens, not on a playback schedule. */
export const runEvents = app.table(
  "run_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    stage: text("stage").notNull(),
    kind: text("kind").notNull().default("info"),
    line: text("line").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("run_events_run_seq").on(t.runId, t.seq)],
);

/* ————————————————————————— per-run detail ————————————————————————— */

/** One row per agent invocation: what ran, on which model, for how long, and
    what it cost. This is what makes the telemetry panel real rather than
    decorative, and it is the audit trail for the whole pipeline. */
export const agentRuns = app.table(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    iteration: integer("iteration").notNull().default(0),
    status: text("status").notNull().default("queued"),
    provider: text("provider"),
    model: text("model"),
    tokens: integer("tokens").notNull().default(0),
    elapsedMs: integer("elapsed_ms"),
    detail: text("detail"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("agent_runs_run_agent_iter").on(t.runId, t.agent, t.iteration)],
);

/** Defects found by the verifier (against the master prompt) and by live QA
    (against the deployed URL). The quality loop feeds these back to the coder,
    which re-patches only the flagged files. */
export const runIssues = app.table(
  "run_issues",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    iteration: integer("iteration").notNull().default(0),
    source: text("source").notNull(), // verify | test
    severity: text("severity").notNull().default("major"), // critical | major | minor
    title: text("title").notNull(),
    detail: text("detail"),
    /** files the fix loop should touch — keeps re-patching surgical */
    files: jsonb("files").notNull().default([]),
    status: text("status").notNull().default("open"), // open | fixed | wontfix
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("run_issues_run_idx").on(t.runId, t.status)],
);

/** The live-QA flows for a run. Generated per project from the spec, never
    reused across products. */
export const runFlows = app.table(
  "run_flows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    intent: text("intent"),
    assertions: integer("assertions").notNull().default(0),
    status: text("status").notNull().default("pending"), // pending | passing | failing | fixed
    attempts: integer("attempts").notNull().default(0),
    durationMs: integer("duration_ms"),
    failure: text("failure"),
  },
  (t) => [uniqueIndex("run_flows_run_pos").on(t.runId, t.position)],
);

/* ————————————————————————— usage metering ————————————————————————— */

/** Per-day per-user counters, so quotas never require a scan of `runs`. */
export const usageDaily = app.table(
  "usage_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: text("day").notNull(), // YYYY-MM-DD, UTC
    builds: integer("builds").notNull().default(0),
    tokens: integer("tokens").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
  },
  (t) => [uniqueIndex("usage_daily_user_day").on(t.userId, t.day)],
);
