"use client";

import { Features } from "./Features";
import { Footer } from "./Footer";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import { InstallBlock } from "./InstallBlock";
import { LandingNav } from "./LandingNav";
import { ToolMatrix } from "./ToolMatrix";

export function Landing() {
  return (
    <div>
      <LandingNav />
      <Hero />
      <Features />
      <ToolMatrix />
      <HowItWorks />
      <InstallBlock />
      <Footer />
    </div>
  );
}

export default Landing;
