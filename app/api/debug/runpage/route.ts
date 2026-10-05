import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

/* TEMP DEBUG — bisects the run page's import chain on production.
   Each step dynamically imports one module; the first failure names it. */

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });

  const steps: Record<string, string> = {};

  const tryStep = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      steps[name] = "ok";
    } catch (e) {
      steps[name] = e instanceof Error ? (e.stack ?? e.message).slice(0, 500) : String(e).slice(0, 500);
    }
  };

  const userId = session.user.id;
  await tryStep("run-dto", () => import("@/lib/run-dto"));
  await tryStep("run-engine", () => import("@/lib/run-engine"));
  await tryStep("orchestrator", () => import("@/lib/pipeline/orchestrator"));
  await tryStep("agents-tester", () => import("@/lib/agents/tester"));
  await tryStep("agents-coder", () => import("@/lib/agents/coder"));
  await tryStep("workspace", () => import("@/lib/platform/workspace"));
  await tryStep("playwright-core", () => import("playwright-core"));
  await tryStep("browser-use", () => import("@/lib/browser-use"));
  await tryStep("getRunState-call", async () => {
    const { getRunState } = await import("@/lib/run-engine");
    await getRunState("8b7d2c5a-053c-4c7a-8c0e-ed3a7878d462", userId);
  });

  return Response.json({ steps });
}
