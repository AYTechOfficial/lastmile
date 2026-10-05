import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { discoverModels } from "@/lib/platform/user-providers";

/* Model discovery for a user's own OpenAI-compatible endpoint. The browser
   cannot call it directly (CORS + the key would sit in the page), so the key
   goes server → provider and only the model list comes back. The key is never
   stored here — it is persisted only when the user saves the provider. */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { baseUrl?: string; apiKey?: string };
  try {
    body = (await req.json()) as { baseUrl?: string; apiKey?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const baseUrl = String(body.baseUrl ?? "").trim();
  const apiKey = String(body.apiKey ?? "").trim();
  if (!baseUrl) return NextResponse.json({ error: "baseUrl is required" }, { status: 400 });

  const result = await discoverModels(baseUrl, apiKey);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ models: result.models }, { headers: { "cache-control": "no-store" } });
}
