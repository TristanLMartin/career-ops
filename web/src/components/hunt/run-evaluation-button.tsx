"use client";
// hunt: "Evaluate" for a job that only has a quick score. Starts the career-ops evaluate
// worker in the lite scope (modes/oferta-lite.md: canonical scoring, Blocks A-C, no interview
// prep or research), the same run the autoscore cron uses. The full evaluation is the job page's
// Deep dive. Progress shows in the Workers tray. Never applies or sends anything.
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { CostBadge } from "@/components/cost/cost-badge";

export function RunEvaluationButton({ url, company, role, estUsd }: { url: string; company: string; role: string; estUsd?: number | null }) {
  const { startJob } = useJobs();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState(false);
  const run = () => {
    const id = startJob({ title: `Evaluate · ${company}`, subtitle: role || url, kind: "evaluate", evaluationScope: "lite", input: url, page: `/pipeline/posting?url=${encodeURIComponent(url)}` });
    if (id) setStarted(true); else setError(true);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={started}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-brand px-4 text-sm font-medium text-brand-foreground hover:bg-brand-200 disabled:opacity-60"
      >
        <Sparkles className="size-4" />
        {started ? "Evaluating…" : typeof estUsd === "number" ? `Evaluate · ≈$${estUsd.toFixed(2)}` : "Evaluate"}
      </button>
      {typeof estUsd !== "number" && <CostBadge kind="spend" size="xs" />}
      {started && <span role="status" className="text-xs text-muted">Running. Watch it in the Workers tray; the report shows up in Jobs when it finishes.</span>}
      {error && <span role="alert" className="text-xs text-red-700 dark:text-red-400">Couldn&apos;t start it. Try again.</span>}
    </div>
  );
}
