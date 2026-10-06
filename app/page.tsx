import { Compare } from "@/components/compare";
import { Faq } from "@/components/faq";
import { Footer } from "@/components/footer";
import { Hero } from "@/components/hero";
import { Marquee } from "@/components/marquee";
import { MouseGlow } from "@/components/ui";
import { Nav } from "@/components/nav";
import { auth } from "@/lib/auth";
import { SmoothScroll } from "@/components/smooth-scroll";
import { PipelineSection } from "@/components/pipeline-section";
import { Problem } from "@/components/problem";
import { ProofPack } from "@/components/proof-pack";
import { Stats } from "@/components/stats";
import { Waitlist } from "@/components/waitlist";

export default async function Home() {
  const session = await auth();
  return (
    <SmoothScroll root>
    <main id="top" className="relative">
      <MouseGlow />
      <Nav authed={!!session?.user} />
      <Hero />
      <Marquee />
      <Problem />
      <PipelineSection />
      <ProofPack />
      <Compare />
      <Stats />
      <Faq />
      <Waitlist />
      <Footer />
    </main>
    </SmoothScroll>
  );
}
