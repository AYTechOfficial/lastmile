# lastmile.

**One sentence in. A verified product out.**

A chained multi-agent pipeline that takes a one-sentence product idea and returns a
live, working URL: it researches the market in real time, writes a senior-engineer-grade
spec, gets your approval, builds the codebase to your GitHub, deploys to your Vercel —
and then tests the **live app** against its core flows, fixing anything broken before
you ever see the link.

## What actually runs today

| Stage | State | What it does |
| --- | --- | --- |
| 01 Research | **real** | Plans its own searches, runs them live, reads pages, synthesises a sourced brief. |
| 02 Spec | **real** | Projects the brief into core flows with acceptance criteria — the tests verify will run. |
| ◆ Checkpoint | **real** | You approve or request changes; nothing builds until you do. |
| 03 Build | planned | Replays a recorded timeline. |
| 04 Deploy & Verify | planned | Replays a recorded timeline. |

The Research Agent runs with **zero API keys** — it falls back to keyless search, which
still returns real, citable sources. Adding a free model key upgrades it from
"search-only" synthesis to a full analysis. The dashboard tells you which tier it is
running on, so nothing is ever dressed up as more than it is.

## Stack

- **Next.js 16** (App Router) + **React 19**
- **Postgres** via **Drizzle** on Supabase (session pooler)
- **Auth.js v5** — email + password (bcrypt) and GitHub OAuth
- **Tailwind CSS v4** — tokens in `app/globals.css`
- **motion** + **lenis** on the marketing page; the app is deliberately motion-light
- Hand-written WebGL (no deps) — the hero's volumetric smoke
- Self-hosted fonts via Fontsource: Inter, Space Grotesk, Instrument Serif, JetBrains Mono

## Run it

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL + AUTH_SECRET at minimum
npm run db:migrate             # idempotent; safe to re-run
npm run dev
```

## Environment

Everything the engine uses is on a free tier. **Keys are optional** — the pipeline runs
degraded-but-real without them and the dashboard says so.

### Models — add any one

| Provider | Variable | Free tier | Get a key |
| --- | --- | --- | --- |
| Google AI Studio | `GEMINI_API_KEY` | generous free tier, no card, 1M context | <https://aistudio.google.com/apikey> |
| Groq | `GROQ_API_KEY` | 30 req/min free, no card, fastest tokens/sec | <https://console.groq.com/keys> |
| Cerebras | `CEREBRAS_API_KEY` | ~1M tokens/day free | <https://cloud.cerebras.ai> |
| OpenRouter | `OPENROUTER_API_KEY` | `:free` model catalog | <https://openrouter.ai/keys> |

All four speak the OpenAI chat-completions dialect, so they share one client. The chain
tries them in order and fails over on errors or rate limits. Reorder with
`AI_PROVIDER_ORDER=groq,gemini`.

### Web search — optional but sharpens the brief

| Provider | Variable | Free tier |
| --- | --- | --- |
| Tavily | `TAVILY_API_KEY` | 1,000 credits/month, no card |
| Exa | `EXA_API_KEY` | free monthly credits |
| DuckDuckGo | _none_ | keyless fallback, always on |

Page reading uses Jina's keyless reader, with a plain-fetch fallback.

### Everything else

```
DATABASE_URL=        # Supabase → Database → Connection string (session pooler)
AUTH_SECRET=         # npx auth secret
AUTH_TRUST_HOST=true
AUTH_GITHUB_ID=      # github.com/settings/developers
AUTH_GITHUB_SECRET=
NEXT_PUBLIC_SIGNUP_MODE=waitlist   # waitlist | open
BROWSER_USE_API_KEY= # cloud browser for live QA (optional; falls back to local Chromium)
```

## Deploying on Zoho Catalyst

The production deployment target is Zoho Catalyst AppSail (Next.js SSR,
Node 20 stack, 1 GB instance):

```bash
npm run pack:catalyst && catalyst deploy --only appsail:lastmile --ignore-scripts
```

The pack script snapshots the build into `deployable/` (slim `.next` + pruned
`next` runtime) and writes `app-config.json` from `.env.local` — both are
gitignored because the latter carries secrets. `AUTH_URL` is excluded
intentionally: it pins Auth.js to localhost and would poison OAuth callbacks;
`AUTH_TRUST_HOST` covers host inference. The startup command is a JS shim
(`deployable/start.js`) that listens on Catalyst's injected
`X_ZOHO_CATALYST_LISTEN_PORT`, since shell-only startup commands do not
expand variables on AppSail.

## Scripts

```bash
npm run dev          # http://localhost:3000
npm run build        # production build (server-rendered — not static)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run db:migrate   # apply drizzle/*.sql (each file is idempotent)
```

## Structure

```
app/
  page.tsx                  marketing page (Lenis smooth scroll lives here, not globally)
  layout.tsx                fonts, metadata, grain overlay
  globals.css               landing tokens + the application design system
  actions/                  server actions: auth, create run, approve, request changes
  api/runs/[id]/state/      polling endpoint for the live run view
  dashboard/
    layout.tsx              app shell: session gate, rail data, live provider status
    page.tsx                overview: composer, telemetry, runs
    runs/[id]/page.tsx      run detail; keyed on the server snapshot
    settings/page.tsx       engine configuration — what to sign up for, and what is live
  error.tsx  not-found.tsx  boundaries in the app's own language
components/
  kit.tsx                   Panel / Section / Badge / Meter / Sparkline / Empty
  app/                      shell, command palette, composer, run list, stage rail,
                            activity log, research brief, spec review, receipts, telemetry
  auth-shell.tsx            split auth layout that shows the pipeline
lib/
  ai/providers.ts           OpenAI-compatible multi-provider client + failover chain
  ai/search.ts              Tavily → Exa → keyless search, and page reading
  ai/json.ts                forgiving JSON extraction from free-model output
  agents/research.ts        the Research Agent
  agents/spec.ts            brief → build spec
  run-engine.ts             stage machine, event bands, agent job runner, watchdog
  run-dto.ts                serialized run state for the client
  schema.ts                 auth tables + runs / run_events / run_flows / agent_runs
drizzle/                    idempotent SQL migrations
scripts/db-migrate.mjs      migration runner
shots.mjs  probe-fog.mjs    visual-QA harnesses (marketing page)
```

## How the engine works

Runs carry an `engine` column. `stub` runs replay a recorded timeline; `live` runs are
driven by real agents.

The Research Agent (`lib/agents/research.ts`) plans queries, searches, opens the
promising pages, then synthesises — emitting a real event for each step. Those events
are what the dashboard streams; the timestamps in the feed are when the work actually
happened. Every competitor URL in the brief is validated against the source list, so the
model cannot invent a link.

Event sequence bands keep the phases from colliding:

```
1    – 999     research  (agent output)
1000 – 1999    checkpoint (approval markers)
2000 – 2999    post-approval (build → deploy → verify)
```

The job runs in-process, fire-and-forget, guarded by a module-scoped set. A run whose
process died mid-flight is picked back up by the watchdog in `advanceRun`, and a re-kick
resumes from the stored brief instead of paying for the same research twice. The job
body is a pure function of `runId`, which is the shape a real queue worker needs.

## Design language

The marketing page is atmospheric — smoke, glows, editorial serif. The app is an
instrument: flat tonal surfaces, hairline edges, tabular numerals, one grid.

Colour carries meaning and nothing else. **Brand** is the pipeline and anything
interactive, **green** is verified (the product's whole promise), **amber** is the human
checkpoint, **red** is failure. App tokens are prefixed `--app-*` and are additive, so the
marketing page keeps its own palette untouched.

## Next milestones

1. **Spec Agent** — its own model pass over the brief, plus per-flow Playwright plans.
2. **Build Agent** — scaffold → codegen → smoke tests → GitHub push.
3. **Deploy & Verify Agent** — Vercel API + Playwright against the live URL + fix loop.
4. **Launch Agent** — GTM kit + verified marketing assets.
