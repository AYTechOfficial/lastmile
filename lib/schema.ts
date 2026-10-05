import {
  boolean,
  integer,
  jsonb,
  uniqueIndex,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

/* Auth.js Drizzle-adapter tables (default singular names) + a passwordHash
   column on user for the email+password credentials flow. */

export const users = pgTable("user", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { withTimezone: true }),
  image: text("image"),
  passwordHash: text("password_hash"),
  plan: text("plan").notNull().default("free"), // free | pro
  /** which GitHub identity hosts this user's generated code:
   *  auto = linked account if present, else the platform-hosted account */
  githubHost: text("github_host").notNull().default("auto"), // auto | account | platform
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/* Singleton admin settings row (id = "app"). `data` holds provider entries
   with AES-256-GCM ciphertext — plaintext keys never touch the database. */
export const platformSettings = pgTable("platform_settings", {
  id: text("id").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const accounts = pgTable(
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

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: uuid("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

/* ————— pipeline runs (dashboard) ————— */

/* `engine` decides how a run advances:
     stub — the original deterministic time-driven timeline (seeded/legacy runs)
     live — real agents drive the pre-approval stages and write their own events,
            while build/deploy/verify still replay the planned timeline until
            those agents land. */
export const runs = pgTable("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  runNumber: integer("run_number").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("queued"),
  currentStage: text("current_stage").notNull().default("research"),
  engine: text("engine").notNull().default("stub"),
  plan: jsonb("plan").notNull(),
  /** ResearchBrief written by the Research Agent */
  research: jsonb("research"),
  /** ProductSpec written by the Spec step */
  spec: jsonb("spec"),
  specVariant: integer("spec_variant").notNull().default(1),
  /** MasterBuildPrompt written by the Prompt Engineer Agent */
  masterPrompt: jsonb("master_prompt"),
  /** quality-loop iterations actually run (code → verify → deploy → test) */
  iterations: integer("iterations").notNull().default(0),
  /** final quality score, 0-100, computed from real test results */
  qualityScore: integer("quality_score"),
  /** orchestrator cursor — lets a crashed job resume exactly where it stopped */
  pipelineState: jsonb("pipeline_state"),
  killRequested: boolean("kill_requested").notNull().default(false),
  zipPath: text("zip_path"),
  /** summary of the last live-QA round: console errors, screenshots, flows */
  testReport: jsonb("test_report"),
  repoUrl: text("repo_url"),
  liveUrl: text("live_url"),
  tokens: integer("tokens").notNull().default(0),
  costCents: integer("cost_cents").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/* Defects found by the Verify Agent (code-level) and the Testing Agent
   (live URL). The quality loop feeds these back to the Coding Agent. */
export const runIssues = pgTable("run_issues", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  iteration: integer("iteration").notNull().default(0),
  source: text("source").notNull(), // verify | test
  severity: text("severity").notNull().default("major"), // critical | major | minor
  title: text("title").notNull(),
  detail: text("detail"),
  status: text("status").notNull().default("open"), // open | fixed
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/* One row per agent invocation — what ran, on which model, for how long, and
   what it cost. This is what makes the dashboard's telemetry panel real rather
   than decorative, and it is the audit trail for the whole pipeline. */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
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
  (t) => [uniqueIndex("agent_runs_run_agent").on(t.runId, t.agent)],
);

export const runEvents = pgTable("run_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  stage: text("stage").notNull(),
  kind: text("kind").notNull().default("info"),
  line: text("line").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex("run_events_run_seq").on(t.runId, t.seq)]);

export const runFlows = pgTable("run_flows", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  name: text("name").notNull(),
  assertions: integer("assertions").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  durationMs: integer("duration_ms"),
}, (t) => [uniqueIndex("run_flows_run_pos").on(t.runId, t.position)]);
