import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "@fontsource/instrument-serif";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://lastmile.build"),
  title: "LastMile — One sentence in. A verified live product out.",
  description:
    "A chained multi-agent pipeline that researches your market, writes the spec, builds the codebase, deploys it — then tests the live app against its core flows and fixes what breaks. You only ever see a link that passed.",
  keywords: [
    "AI app builder",
    "multi-agent pipeline",
    "verified deployment",
    "autonomous coding agent",
    "LastMile",
  ],
  openGraph: {
    title: "LastMile — One sentence in. A verified live product out.",
    description:
      "Research → spec → your approval → build → deploy & verify. The pipeline doesn't stop at “code generated” — it proves the live product works, with receipts.",
    type: "website",
    siteName: "LastMile",
  },
  twitter: {
    card: "summary_large_image",
    title: "LastMile — One sentence in. A verified live product out.",
    description:
      "The last mile — checking the live app and fixing it — finally belongs to the pipeline, not to you.",
  },
};

export const viewport: Viewport = {
  themeColor: "#07080b",
};

/* Note: Lenis smooth scrolling lives inside the marketing page, not here.
   Scroll-hijacking is a feature on a long narrative page and a bug in an app. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="antialiased">
      <body className="bg-ink font-sans text-cream">
        {children}
        <div aria-hidden className="grain-overlay" />
      </body>
    </html>
  );
}
