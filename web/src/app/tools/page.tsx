"use client";

import { useEffect, useState } from "react";
import { api, ToolSummary } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import ToolCard from "@/components/dashboard/ToolCard";
import { TopBar } from "@/components/aurora/primitives";

export default function ToolsPage() {
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const { t } = useI18n();

  useEffect(() => { api.getTools().then(setTools).catch(console.error); }, []);

  return (
    <div className="max-w-6xl mx-auto">
      <TopBar title={t.tools.title} subtitle={`${tools.length} ${t.nav.tools}`} />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {tools.map((tl) => <ToolCard key={tl.id} tool={tl} />)}
      </div>
    </div>
  );
}
