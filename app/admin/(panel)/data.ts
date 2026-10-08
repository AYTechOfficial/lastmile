import { desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { creditEvents, runs, users } from "@/lib/schema";

/* The panel's reads. Kept in one place so the dashboard and the section pages
   count the same things the same way — a panel that shows two different run
   totals on two pages is worse than one that shows neither. */

export type AccountView = {
  id: string;
  email: string | null;
  name: string | null;
  plan: string;
  credits: number;
  suspendedAt: string | null;
  createdAt: string;
  runs: number;
  tokens: number;
  spendMilli: number;
};

/* One statement, aliased, rather than three correlated subqueries written
   through the query builder: an unqualified column id inside a subquery about
   `runs` resolves to the runs table's own id, not the user's, so every account
   read as "0 runs, 0 tokens" while the runs page showed the real totals. The
   join cannot express that mistake. */
export async function accountsWithUsage(limit = 200): Promise<AccountView[]> {
  const rows = await db.execute(sql`
    select u.id,
           u.email,
           u.name,
           u.plan,
           u.credits_milli,
           u.suspended_at,
           u.created_at,
           count(r.id)::int as runs,
           coalesce(sum(r.tokens), 0)::int as tokens,
           coalesce((
             select -sum(c.delta_milli)::int from lastmile.credit_events c
              where c.user_id = u.id and c.delta_milli < 0
           ), 0)::int as spend_milli
      from lastmile."user" u
      left join lastmile.runs r on r.user_id = u.id
     group by u.id
     order by u.created_at desc
     limit ${limit}
  `);

  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    email: (r.email as string | null) ?? null,
    name: (r.name as string | null) ?? null,
    plan: String(r.plan),
    credits: Number(r.credits_milli ?? 0),
    suspendedAt: r.suspended_at ? new Date(r.suspended_at as string).toISOString() : null,
    createdAt: new Date(r.created_at as string).toISOString(),
    runs: Number(r.runs ?? 0),
    tokens: Number(r.tokens ?? 0),
    spendMilli: Math.abs(Number(r.spend_milli ?? 0)),
  }));
}

export type Overview = {
  accounts: number;
  suspended: number;
  runs: number;
  runsToday: number;
  inFlight: number;
  tokens: number;
  tokensToday: number;
  spendMilli: number;
  spendTodayMilli: number;
  grantedMilli: number;
  balanceMilli: number;
  verifiedRuns: number;
  avgScore: number | null;
  liveUrls: number;
};

export async function overview(): Promise<Overview> {
  const [row] = await db.execute(sql`
    select
      (select count(*)::int from lastmile."user") as accounts,
      (select count(*)::int from lastmile."user" where suspended_at is not null) as suspended,
      (select count(*)::int from lastmile.runs) as runs,
      (select count(*)::int from lastmile.runs where created_at >= date_trunc('day', now())) as runs_today,
      (select count(*)::int from lastmile.runs where status in ('queued','running','awaiting_approval')) as in_flight,
      (select coalesce(sum(tokens), 0)::int from lastmile.runs) as tokens,
      (select coalesce(sum(tokens), 0)::int from lastmile.runs where created_at >= date_trunc('day', now())) as tokens_today,
      (select coalesce(-sum(delta_milli), 0)::int from lastmile.credit_events where delta_milli < 0) as spend_milli,
      (select coalesce(-sum(delta_milli), 0)::int from lastmile.credit_events where delta_milli < 0 and created_at >= date_trunc('day', now())) as spend_today_milli,
      (select coalesce(sum(delta_milli), 0)::int from lastmile.credit_events where delta_milli > 0) as granted_milli,
      (select coalesce(sum(credits_milli), 0)::int from lastmile."user") as balance_milli,
      (select count(*)::int from lastmile.runs where quality_score >= 100) as verified_runs,
      (select round(avg(quality_score))::int from lastmile.runs where quality_score is not null) as avg_score,
      (select count(*)::int from lastmile.runs where live_url is not null) as live_urls
  `);

  const r = row as unknown as Record<string, number | null>;
  return {
    accounts: Number(r.accounts ?? 0),
    suspended: Number(r.suspended ?? 0),
    runs: Number(r.runs ?? 0),
    runsToday: Number(r.runs_today ?? 0),
    inFlight: Number(r.in_flight ?? 0),
    tokens: Number(r.tokens ?? 0),
    tokensToday: Number(r.tokens_today ?? 0),
    spendMilli: Number(r.spend_milli ?? 0),
    spendTodayMilli: Number(r.spend_today_milli ?? 0),
    grantedMilli: Number(r.granted_milli ?? 0),
    balanceMilli: Number(r.balance_milli ?? 0),
    verifiedRuns: Number(r.verified_runs ?? 0),
    avgScore: r.avg_score === null || r.avg_score === undefined ? null : Number(r.avg_score),
    liveUrls: Number(r.live_urls ?? 0),
  };
}

export type DayPoint = {
  day: string;
  runs: number;
  tokens: number;
  spendMilli: number;
  signups: number;
};

/** The last `days` days, oldest first, with zeroes for days that have nothing —
    a chart that skips empty days lies about the shape of the week. */
export async function dailySeries(days = 14): Promise<DayPoint[]> {
  const rows = await db.execute(sql`
    with grid as (
      select generate_series(
        date_trunc('day', now()) - make_interval(days => ${days - 1}),
        date_trunc('day', now()),
        interval '1 day'
      ) as day
    ),
    r as (
      select date_trunc('day', created_at) as day, count(*)::int as runs, coalesce(sum(tokens), 0)::int as tokens
        from lastmile.runs group by 1
    ),
    c as (
      select date_trunc('day', created_at) as day, coalesce(-sum(delta_milli), 0)::int as spend
        from lastmile.credit_events where delta_milli < 0 group by 1
    ),
    u as (
      select date_trunc('day', created_at) as day, count(*)::int as signups
        from lastmile."user" group by 1
    )
    select to_char(g.day, 'Mon DD') as day,
           coalesce(r.runs, 0) as runs,
           coalesce(r.tokens, 0) as tokens,
           coalesce(c.spend, 0) as spend_milli,
           coalesce(u.signups, 0) as signups
      from grid g
      left join r on r.day = g.day
      left join c on c.day = g.day
      left join u on u.day = g.day
     order by g.day
  `);

  return (rows as unknown as Record<string, unknown>[]).map((row) => ({
    day: String(row.day),
    runs: Number(row.runs ?? 0),
    tokens: Number(row.tokens ?? 0),
    spendMilli: Number(row.spend_milli ?? 0),
    signups: Number(row.signups ?? 0),
  }));
}

export type ProviderMix = { provider: string; tokens: number; runs: number };

/** Tokens by the provider that answered, read from the recorded attempts. The
    run events carry the model line, so this is the only place the panel can see
    which host is actually doing the work. */
export async function providerMix(limit = 8): Promise<ProviderMix[]> {
  const rows = await db.execute(sql`
    select split_part(replace(line, 'model ', ''), '/', 1) as provider,
           count(*)::int as runs,
           0::int as tokens
      from lastmile.run_events
     where kind = 'success' and line like '% answered in %'
     group by 1
     order by runs desc
     limit ${limit}
  `);
  return (rows as unknown as Record<string, unknown>[])
    .map((r) => ({ provider: String(r.provider).trim(), runs: Number(r.runs ?? 0), tokens: Number(r.tokens ?? 0) }))
    .filter((r) => r.provider.length > 0);
}

export type RunView = {
  id: string;
  runNumber: number;
  sentence: string;
  status: string;
  stage: string | null;
  score: number | null;
  tokens: number;
  liveUrl: string | null;
  email: string | null;
  createdAt: string;
};

export async function recentRuns(limit = 40): Promise<RunView[]> {
  const rows = await db
    .select({
      id: runs.id,
      runNumber: runs.runNumber,
      sentence: runs.sentence,
      status: runs.status,
      stage: runs.currentStage,
      score: runs.qualityScore,
      tokens: runs.tokens,
      liveUrl: runs.liveUrl,
      email: users.email,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .innerJoin(users, eq(users.id, runs.userId))
    .orderBy(desc(runs.createdAt))
    .limit(limit);

  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export type LedgerView = {
  id: string;
  delta: number;
  balance: number;
  reason: string;
  email: string | null;
  createdAt: string;
};

export async function recentLedger(limit = 25): Promise<LedgerView[]> {
  const rows = await db
    .select({
      id: creditEvents.id,
      delta: creditEvents.deltaMilli,
      balance: creditEvents.balanceMilli,
      reason: creditEvents.reason,
      email: users.email,
      createdAt: creditEvents.createdAt,
    })
    .from(creditEvents)
    .innerJoin(users, eq(users.id, creditEvents.userId))
    .orderBy(desc(creditEvents.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
