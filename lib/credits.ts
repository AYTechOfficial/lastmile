import { eq, sql } from "drizzle-orm";
import { db } from "./db";
import { creditEvents, users } from "./schema";
import { getPlatformData } from "./platform/settings";

/* The credit economy, in one module.

   A credit is a thousandth of a dollar (milli-USD), held as an integer — the
   same unit the ledger stores. Tokens are charged at the operator's
   admin-configured price per million, clamped so a balance never goes
   negative, and every movement lands in the ledger with the balance captured
   at write time.

   Charging happens where the tokens are counted: the runner, after a stage
   reports its usage. The dashboard only checks the balance before a run can
   start — one source of truth for the arithmetic. */

export type CreditMovement = {
  chargedMilli: number;
  balanceMilli: number;
};

/** The operator's price for 1M tokens, in milli-USD. */
export async function pricePerMillionMilli(): Promise<number> {
  const { credits } = await getPlatformData();
  return credits.pricePerMillionMilli > 0 ? credits.pricePerMillionMilli : 1000;
}

export async function getBalanceMilli(userId: string): Promise<number> {
  const [row] = await db
    .select({ credits: users.creditsMilli })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.credits ?? 0;
}

/** Charge for tokens a stage actually spent. Never throws into the runner:
    a metering failure must not fail a stage that already did its work. */
export async function chargeRunTokens(
  userId: string,
  runId: string,
  tokens: number,
  reason: string,
): Promise<CreditMovement> {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return { chargedMilli: 0, balanceMilli: await getBalanceMilli(userId) };
  }
  try {
    const price = await pricePerMillionMilli();
    const cost = Math.max(1, Math.ceil((tokens / 1_000_000) * price));

    /* Clamp at zero: a slightly overdrawn account stops at $0 rather than
       going negative — the next run start is what gets refused. */
    const [row] = await db
      .update(users)
      .set({ creditsMilli: sql`GREATEST(${users.creditsMilli} - ${cost}, 0)` })
      .where(eq(users.id, userId))
      .returning({ balance: users.creditsMilli });
    const balance = row?.balance ?? 0;

    await db.insert(creditEvents).values({
      userId,
      runId,
      deltaMilli: -cost,
      balanceMilli: balance,
      reason,
    });

    return { chargedMilli: cost, balanceMilli: balance };
  } catch (error) {
    console.error("credit charge failed", { userId, runId, tokens, error });
    return { chargedMilli: 0, balanceMilli: await getBalanceMilli(userId) };
  }
}

/** Grant credits (signup, admin top-up, comp). Always ledgered. */
export async function grantCredits(
  userId: string,
  amountMilli: number,
  reason: string,
  runId: string | null = null,
): Promise<CreditMovement> {
  if (!Number.isFinite(amountMilli) || amountMilli === 0) {
    return { chargedMilli: 0, balanceMilli: await getBalanceMilli(userId) };
  }
  const [row] = await db
    .update(users)
    .set({ creditsMilli: sql`GREATEST(${users.creditsMilli} + ${amountMilli}, 0)` })
    .where(eq(users.id, userId))
    .returning({ balance: users.creditsMilli });
  const balance = row?.balance ?? 0;

  await db.insert(creditEvents).values({
    userId,
    runId,
    deltaMilli: amountMilli,
    balanceMilli: balance,
    reason,
  });

  return { chargedMilli: amountMilli, balanceMilli: balance };
}

/** Format milli-USD for a human: 9_420 → "$9.42". */
export function fmtMilli(milli: number): string {
  return "$" + (milli / 1000).toFixed(2);
}
