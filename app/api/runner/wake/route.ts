import { timingSafeEqual } from "node:crypto";
import { sweepAndWake } from "@/lib/platform/wake";

/* The runner's alarm clock.

   Something has to call this on a timer, because the queue is passive: a job
   that is waiting and has no runner holding it will wait forever. Supabase Cron
   calls it every two minutes via pg_net, which is why this endpoint is on the
   public internet and why it is guarded by a shared secret rather than a
   session — a database cannot sign in.

   What the secret buys, and what it does not: whoever holds it can make this
   endpoint reclaim expired leases and, when work is genuinely waiting, start a
   GitHub Actions runner. They cannot read a run, touch a user's data, or reach
   any other part of the app. It is a doorbell, not a key. The GitHub token
   itself never leaves the deployment — the database is told the secret and
   nothing else, so a leak of the queue's contents does not leak a token that
   can write to your repositories.

   The run page will call the same function on its live poll once it exists, so
   a run you are watching repairs itself without waiting for the timer. The
   endpoint exists first because the database needs a URL to call. */

export const dynamic = "force-dynamic";

/** Constant-time compare, so the endpoint does not leak the secret's length or
    prefix through response timing. */
function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function handle(request: Request): Promise<Response> {
  const expected = process.env.WAKE_SECRET?.trim();

  /* No secret configured means no way to tell a legitimate caller from a
     stranger. Refusing is the only safe answer — an open endpoint that starts
     Actions runs on demand is someone else's compute bill. */
  if (!expected) {
    return Response.json(
      { error: "The wake endpoint is not configured on this deployment." },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const given =
    request.headers.get("x-wake-secret")?.trim() ?? url.searchParams.get("key")?.trim() ?? "";

  if (!secretMatches(given, expected)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const result = await sweepAndWake();

  /* The result is the explanation, not just a status: which leases were
     reclaimed, how much work is waiting, and why a runner was or was not
     woken. pg_net stores this response in `net._http_response`, so the reason a
     sweep did nothing is readable after the fact. */
  return Response.json(result);
}

/* POST is what pg_net sends; GET is for a browser or a curl during debugging.
   Both are equally guarded. */
export const POST = handle;
export const GET = handle;
