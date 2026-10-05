import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Deploying on Zoho Catalyst AppSail: `npm run build`, then
     `npm run pack:catalyst` (see scripts/catalyst-pack.mjs). Under the
     default turbopack build this flag is inert — server deps are bundled
     into .next/server/chunks and the pack script ships them with a pruned
     `next` runtime; a webpack build would additionally emit the classic
     .next/standalone tree. */
  output: "standalone",
};

export default nextConfig;
