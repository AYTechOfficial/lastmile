# Last Mile — forensic analysis of the previous build

Source analysed: `F:\New Developemnts\lastmile` (Next.js 16 / React 19, branch `main`, 14 commits)
Current rebuild workspace: `F:\New Developemnts\AI AGENT PIPEPLINE\gg 2` (empty)

Verdict up front: **the code is not what failed. `npm run typecheck` passes clean at the
current working tree.** What failed is the *shape* of the deployment — a stateful,
CPU-heavy, disk-heavy agent runtime squeezed into a single 1 GB Zoho Catalyst AppSail
instance, shipped as a hand-assembled 246 MB artifact. Everything below is evidence.

---

## 1. What already exists (and it is a lot)

Old Last Mile is not a sketch. It is roughly the product described in the brief:

| Layer | Files | State |
| --- | --- | --- |
| Agents | `lib/agents/{research,spec,prompt-engineer,coder,verifier,tester,scope}.ts` | real, except `scope` |
| Orchestrator | `lib/pipeline/orchestrator.ts` (703 L) | real, resumable stage machine |
| Engine | `lib/run-engine.ts` (573 L) | stub timeline + live agent events |
| Model access | `lib/ai/providers.ts` (393 L) | multi-provider OpenAI-dialect chain + failover |
| Search | `lib/ai/search.ts` (338 L) | Tavily → Exa → keyless |
| Live QA | `lib/browser-use.ts` + `lib/agents/tester.ts` | cloud browser, local Chromium fallback |
| Platforms | `lib/platform/{github,vercel,workspace,settings,user-providers}.ts` | real |
| Plans | `lib/plans.ts` | free/pro: dailyBuilds, maxIterations, codeVerifyRounds |
| Schema | `lib/schema.ts` | users, runs, agent_runs, run_events, run_flows, run_issues, user_providers, platform_settings |
| Admin | `app/admin/page.tsx` (295 L) | users, live runs, kill, providers, infra tokens, plan assignment, token usage by agent |
| Dashboard | `app/dashboard/**` + `components/app/**` | shell, composer, stage rail, pipeline canvas, spec review, receipts, telemetry, code viewer |
| Marketing + auth | `app/page.tsx`, `app/login`, `app/signup` | done |

Pipeline stages already implemented: `prompt → code → verify → deploy → test`, with a
quality loop (fix → redeploy → retest) bounded by `plan.maxIterations`, defects recorded
in `run_issues` and fed back to the coder.

`README.md` still says Build and Deploy & Verify are "planned", but `lib/agents/coder.ts`
is 1406 lines of real work and the deploy/test stages call real APIs. **Docs and code
diverged** — a signal that end-to-end was never actually proven on the target platform.

---

## 2. Why it dies on Zoho Catalyst

### 2.1 The build artifact is hand-assembled and 246 MB

`scripts/catalyst-pack.mjs` manually copies `.next/server|static|build`, then walks
`node_modules` to rebuild Next's dependency closure by hand.

```
deployable/            246 MB
  node_modules/        206 MB     ← hand-rolled closure copy
  .next/server/         25 MB
  .next/static/        1.7 MB
```

`next.config.ts` sets `output: "standalone"` and its own comment admits the flag is
**inert under Turbopack**. So the 206 MB is a workaround for a flag that isn't working.
Every Next.js upgrade will silently break this.

### 2.2 The whole project source is being traced into the server bundle

Build warning, verbatim:

```
./lib/agents/coder.ts:231:14
Warning: Dynamic filesystem access causes tracing of the whole project
  231 |  rmSync(join(dir, entry), { recursive: true, force: true });
```

Confirmed on disk: `.next/standalone/lib/agents/coder.ts` exists. The agent source ships
with the server output, because a `rmSync` over `["app","src","components","lib",...]`
makes Turbopack give up on static tracing and include everything. That is what pushed
`.next/server` to 25 MB of chunks and made the artifact fragile.

### 2.3 Generated codebases are built *on the app instance*

`lib/agents/coder.ts` runs real child processes in the request process:

```
npm install --no-audit --no-fund      timeout 420s
npx tsc --noEmit                      timeout 300s
npx next build                        timeout 420s
```

Locally this has already produced **`.builds/` = 3.7 GB** across a handful of runs, each
with its own `app/` + `node_modules/`. On a 1024 MB AppSail instance this is the fatal
one: a Next.js production build alone wants more memory than the instance has, and the
disk churn is unbounded. A 1 GB free-tier instance cannot host a build farm.

### 2.4 Runs live in the web process, not in a worker

`kickPipeline` is fire-and-forget with a module-scoped `Set` guard; `lib/run-engine.ts`
picks up runs whose process died. That is a reasonable *local* design, but on AppSail any
restart, redeploy, or platform recycle kills every in-flight run, and there is no queue,
no lease, no heartbeat. Long multi-minute agent pipelines inside a request process on a
single instance is the core reliability gap.

### 2.5 The proxy lies about Host, and the app had to be patched around it

Two separate workarounds for the same platform behaviour — AppSail presents the container
with `Host: localhost:<port>` while the browser sends the real `Origin`:

1. `experimental.serverActions.allowedOrigins` in `next.config.ts` pinned to
   `lastmile-30044798715.development.catalystappsail.eu` — one hardcoded domain, needing a
   code change for every new environment or custom domain.
2. `deployable/start.js` — a generated startup shim that also runs a **reverse proxy**
   rewriting `Host` on every request, spawned because shell startup commands don't expand
   `${}` on AppSail.

The git log corroborates the debugging: *"Temporarily surface the run-page server error
for debugging"*, *"Fix the bisect endpoint's module paths"*.

### 2.6 Secrets are materialised into files on disk

`pack:catalyst` reads `.env.local` and writes every value into `deployable/.env` **and**
`app-config.json` — Supabase password, Vercel token, GitHub OAuth secret, model keys,
`AUTH_SECRET`. Both are gitignored (verified: `git check-ignore` matches, only
`.env.example` is tracked), so nothing leaked into git. But plaintext operator credentials
now sit in the tree, and `/admin` is gated by a hardcoded `ADMIN_EMAILS` list.

**These credentials should be rotated before the rebuild** — they have been in a build
artifact, not just an env file.

### 2.7 The tree is mid-refactor and uncommitted

```
 M app/actions/auth.ts        ?? app/dashboard/settings/signout-button.tsx
 M app/dashboard/settings/page.tsx   ?? app/login/github-signin.tsx
 M app/login/{page,login-form}.tsx   ?? lib/client-auth.ts
 M app/signup/{page,signup-form}.tsx
 M components/app/{shell,command-palette}.tsx
 M next.config.ts  M scripts/catalyst-pack.mjs
```

HEAD is not the state that was last deployed. The project was left mid-way through an
auth/shell refactor while production debugging was still going on.

---

## 3. What to keep, what to change

**Keep the design** — the schema, the stage machine, the banded event log, the provider
failover chain, the T+S search chain, the plan quotas, the admin surface. That work is
good and it matches the brief.

**Change the deployment shape** — this is the entire reason for the rebuild:

| Problem | What the rebuild must do instead |
| --- | --- |
| 246 MB hand-packed artifact | Real `output: "standalone"` build, or a container. Never walk `node_modules` by hand. |
| Whole project traced into server output | Eliminate dynamic FS access from request-reachable code; `/* turbopackIgnore: true */` or move it behind a worker boundary. |
| `npm install` + `next build` on the web instance | Move generated-app builds off the instance: external sandbox/CI, or Catalyst Stratus + a job runner. The web app must never run a Next build. |
| 3.7 GB local workspaces | Workspace in object storage, per-run, with explicit lifecycle/GC. |
| Fire-and-forget in-process runs | Durable queue + leases + heartbeats. Web requests only enqueue. |
| Hardcoded origin workarounds | One env-driven origin, no per-domain code edits. |
| Secrets written to disk by the packer | Secrets only in the platform's env config; packer never sees them. |

---

## 4. Why the Run button produced a digest error

Two independent failures stacked on top of each other.

**A. Module resolution broke in the hand-packed artifact.** `lib/agents/tester.ts` imports
`playwright-core`. Turbopack externalises it as a virtual package
`.next/node_modules/playwright-core-<hash>`, and `catalyst-pack.mjs` documents the
consequence in its own comment:

> *"Without this directory every route/pipeline importing them dies with
> ERR_MODULE_NOT_FOUND and Next serves a bare 'Internal Server Error'."*

The run page and the create-run action both pull in
`run-engine → orchestrator → tester/coder → playwright-core`. When that import fails, the
server action throws, and Next surfaces it to the browser as a digest error. The commit
trail is unambiguous — *"Temporarily surface the run-page server error for debugging"*
followed by a bisect route that imports nine modules in sequence to find which one breaks:

```
run-dto → run-engine → orchestrator → agents-tester → agents-coder
→ workspace → playwright-core → browser-use → getRunState-call
```

**B. Server actions were being rejected by the platform's Host header.** `next.config.ts`
carries a pinned `allowedOrigins` entry with the operator's own comment explaining that
AppSail presents the container with `Host: localhost:<port>` while the browser sends the
real `Origin`, so Next's CSRF check aborts every action as an attack — *"Invalid Server
Actions request", digest …@E80 — surfaced to users as React error #441 on the composer and
spec-review forms.*

So the Run click failed on the way in (action rejected / import missing) **and would have
failed anyway on the way out** — see below.

---

## 5. Hosting verdict: Zoho Catalyst AppSail is the wrong class of host

Not a tuning problem. Zoho's own AppSail documentation rules the workload out on three
independent counts.

| AppSail limit (Zoho docs) | What our pipeline needs |
| --- | --- |
| *"An app request needs to be completed in 30 seconds. Otherwise, the request will be timed out."* | Research → build → verify → deploy → test is minutes to tens of minutes. |
| *"Inactive app instances will be scaled down after 5 minutes of uptime."* | A worker must stay up for the whole run and survive the HTTP response. |
| *"Catalyst assigns 256 MB for the disk size and 512 MB for the memory by default."* | `npm install` + `npx next build` need GBs of disk; a Next production build wants more RAM than the instance has. |
| Listen within 10 s of spawn; 100 concurrent requests per instance; max 5 instances per app. | Fine — but irrelevant once the above are unmet. |
| Billed on **instance uptime**, not requests. | An always-on instance drains the free allowance while idle. |

Add that the *"free tier allowance is only available with the pay-as-you-go pricing
model"*, and that Catalyst *"will prompt you to set up your payment method as soon as any
resource's free tier allowance is about to expire"* — so "free" here still expects a card
on file.

**Conclusion: no amount of code quality makes AppSail host this product.** The landing page
and dashboard loaded because they are ordinary request/response renders. The Run button
failed because it is the first thing that asks the platform to do sustained work.

### The constraint nobody escapes

A genuinely free, always-on host with a filesystem and minutes of CPU does not exist in
serverless form. The catalog confirms it: Vercel's own listing states it is *"Not suitable
for backend-only workloads, long-running servers"*, and its Hobby plan is *"free forever
for personal and non-commercial projects"* — **commercial use requires Pro**. Render's free
tier is 512 MB and sleeps after 15 minutes; free Postgres there expires in 30 days.

So the free-only architecture has to be assembled from parts that each do what they are
actually good at:

| Plane | What runs there | Free option |
| --- | --- | --- |
| **Control plane** | Next.js dashboard, auth, Postgres reads/writes, enqueue | The always-on VM (below), or Cloudflare if split |
| **Worker plane** | Agent pipeline: multi-minute jobs, needs a persistent process + disk | **Oracle Cloud Always Free** ARM VM — always-on, no expiry (2 OCPU / 12 GB RAM since Oracle halved it in June 2026) |
| **Build farm** | `npm install` + `next build` for *generated* projects | **GitHub Actions** on each project repo — 2,000 free min/month private (unlimited public), 4 CPU / 16 GB RAM / 14 GB SSD per runner |
| **Database** | Runs, events, accounts | Supabase free (already built against it) or Neon free |
| **Product output** | The user's deployed app | Vercel, per-user token — not our hosting |

The build farm insight is the important one: we already create a GitHub repo per project,
so the generated app can be built and tested **by GitHub and never by our server**. That
removes the single most destructive thing the old code did.

### The rule the rebuild must enforce

> The web app never runs a build. Web requests only enqueue a job.
> A separate always-on worker claims jobs from Postgres with leases and heartbeats.
> Generated-app builds happen on GitHub Actions or a single-slot local sandbox — never in
the request process, never on the dashboard host.

---

## 6. Open questions before the rebuild starts

1. **Where does the new app live** — fresh directory vs. reuse of the `lastmile` tree?
2. **Confirm the host**: Oracle Always Free VM (self-host, $0, needs card for
   verification) vs. Cloudflare for the UI + Oracle for the worker vs. a ~$5/mo VPS.
3. **Rotate the old credentials** before anything is wired up again.
