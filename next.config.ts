import type { NextConfig } from "next";

/* The dashboard deploys to Vercel as an ordinary Next.js app.

   Deliberately absent: any hardcoded origin. The previous deployment pinned a
   single platform domain into `serverActions.allowedOrigins`, which meant every
   new domain or environment required a code change and a redeploy. Origins now
   come from the environment.

   Vercel sets Host and Origin consistently, so this stays empty there. It only
   matters if the app is ever fronted by a proxy that rewrites Host. */

const allowedOrigins = (process.env.SERVER_ACTION_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  ...(allowedOrigins.length > 0
    ? { experimental: { serverActions: { allowedOrigins } } }
    : {}),
  /* The agent pipeline is NOT part of this build. Nothing in the request path
     imports a child-process runner, a browser driver, or a workspace module —
     that separation is what keeps the deployable small and the dashboard alive
     on a serverless host. */
};

export default nextConfig;
