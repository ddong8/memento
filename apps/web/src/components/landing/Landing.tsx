"use client";

import { BootstrapBlock } from "./BootstrapBlock";
import { DesktopBlock } from "./DesktopBlock";
import { Features } from "./Features";
import { Footer } from "./Footer";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import { InstallBlock } from "./InstallBlock";
import { LandingNav } from "./LandingNav";
import { ToolMatrix } from "./ToolMatrix";
import { WorkbenchBlock } from "./WorkbenchBlock";

export function Landing() {
  return (
    <div>
      <LandingNav />
      <Hero />
      <Features />
      <WorkbenchBlock />
      <ToolMatrix />
      <HowItWorks />
      <BootstrapBlock />
      <InstallBlock />
      <DesktopBlock />
      <Footer />
    </div>
  );
}
