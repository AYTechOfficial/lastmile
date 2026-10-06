import { auth } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

/* Listing the models an endpoint serves.

   Called while the user types their key in Settings, so it runs on the server:
   the key is never sent from the browser directly to the provider, which keeps
   CORS out of the picture and stops the key appearing in a third party's logs
   from our page.

   This is also why the endpoint is authenticated and rate limited — it is a
   server-side fetcher for an arbitrary user-supplied URL, and without those two
   things it would be an open proxy. */

export const dynamic = "force-dynamic";

type Body = { baseUrl?: string; apiKey?: string };

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }

  const limited = await rateLimit(`discover:${session.user.id}`, 20, 60_000);
  if (!limited.ok) {
    return Response.json({ error: "Too many attempts — wait a moment." }, { status: 429 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Malformed request." }, { status: 400 });
  }

  const baseUrl = (body.baseUrl ?? "").trim().replace(/\/+$/, "");
  const apiKey = (body.apiKey ?? "").trim();

  if (!baseUrl || !apiKey) {
    return Response.json({ error: "Base URL and API key are both required." }, { status: 400 });
  }

  /* https only, and no credentials in the URL — this request carries a secret
     to whatever host is named here. */
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return Response.json({ error: "That base URL is not valid." }, { status: 400 });
  }
  if (url.protocol !== "https:") {
    return Response.json({ error: "The base URL must use https." }, { status: 400 });
  }
  if (url.username || url.password) {
    return Response.json({ error: "Remove the credentials from the base URL." }, { status: 400 });
  }

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return Response.json(
        {
          error:
            res.status === 401 || res.status === 403
              ? "That key was rejected by the endpoint."
              : `The endpoint returned ${res.status}.`,
        },
        { status: 200 },
      );
    }

    const payload = (await res.json()) as { data?: { id?: string }[] };
    const models = (payload.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort();

    return Response.json({ models });
  } catch {
    return Response.json({ error: "Could not reach that endpoint." }, { status: 200 });
  }
}
