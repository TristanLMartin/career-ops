// hunt: one job that has no full evaluation yet (only a quick score): the posting link, pay
// (posted, or "Pay not listed"), the quick score and its one-line reason, and "Run full
// evaluation". A job that already has a report redirects to it. Opened from Jobs rows and the Map.
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { PageFrame } from "@/components/page-frame";
import { RunEvaluationButton } from "@/components/hunt/run-evaluation-button";
import { scopeEstimate } from "@/lib/hunt-scope-estimate";
import { readHuntEnrichment } from "@/lib/hunt-data";
import { rankMap, stretchLabel } from "@/lib/hunt-rank-order.mjs";
import { StretchBadge, WhyThisRank } from "@/components/hunt/rank-badges";
import type { HuntEnrichment } from "@/lib/hunt-types";
import { payLine } from "@/lib/hunt-job-pay.mjs";

export const dynamic = "force-dynamic";

export default async function PostingDetail({ searchParams }: { searchParams: Promise<{ url?: string | string[] }> }) {
  const raw = (await searchParams).url;
  const url = Array.isArray(raw) ? raw[0] : raw;
  if (!url || !/^https?:\/\//i.test(url)) notFound();
  const allJobs = readHuntEnrichment().jobs;
  const e = allJobs[url] as (Record<string, unknown> & {
    company?: string; role?: string; displayRole?: string; location?: string; quick_score?: number; quick_why?: string;
    fit?: number; report?: { tracker?: string | number | null; why?: string } | null; status?: string; composite?: number; contract?: boolean;
  }) | undefined;
  if (!e) notFound();
  if (e.report?.tracker) redirect(`/pipeline/${encodeURIComponent(String(e.report.tracker))}`);
  const company = e.company ?? "";
  const role = e.displayRole || e.role || "";
  const pay = payLine(e);
  const rank = rankMap(allJobs).get(url) ?? null;
  const btn = "inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border px-4 text-sm font-medium text-foreground hover:bg-surface-hover";
  return (
    <PageFrame>
      <Link href="/pipeline" className="inline-flex min-h-[44px] items-center gap-1 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" />Jobs</Link>
      {rank != null && <p className="mt-1 text-sm font-semibold tabular-nums text-brand-text" title="Best overall rank">#{rank}</p>}
      <h1 className="mt-1 font-display text-2xl tracking-tight text-landing [overflow-wrap:anywhere]">{company}</h1>
      <p className="mt-1 text-base text-foreground [overflow-wrap:anywhere]">{role}</p>
      {e.location && <p className="mt-0.5 text-sm text-muted">{e.location}</p>}

      <section className="mt-4 rounded-xl border border-border p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-faint">Why it was recommended</p>
        {typeof e.quick_score === "number" ? (
          <p className="mt-1 text-base text-foreground"><span className="font-semibold tabular-nums">Quick score {e.quick_score}/5</span>{e.quick_why ? <span className="text-muted"> · {e.quick_why}</span> : null}</p>
        ) : (
          <p className="mt-1 text-sm text-muted">Not scored yet.</p>
        )}
        <p className="mt-2 text-xs text-faint">A quick score reads the title and the start of the posting. Evaluate reads the whole posting against your profile and scores it. Deep dive on the job page adds the resume, interview prep and research when you want to apply.</p>
      </section>

      <section className="mt-3 rounded-xl border border-border p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-faint">Pay</p>
        <p className="mt-1 text-sm text-foreground [overflow-wrap:anywhere]" data-testid="posting-pay">{pay.text}</p>
      </section>

      <div className="mt-4 flex flex-wrap gap-2">
        <a href={url} target="_blank" rel="noreferrer" className={btn}>Open posting<ExternalLink className="size-3.5 text-faint" /></a>
      </div>

      {stretchLabel(e) && <p className="mt-4 flex items-center gap-2 text-xs text-muted"><StretchBadge e={e as unknown as HuntEnrichment} /><span>{stretchLabel(e)!.title}</span></p>}
      <section className="mt-4"><WhyThisRank e={e as unknown as HuntEnrichment} rank={rank} /></section>

      <section className="mt-5">
        <RunEvaluationButton url={url} company={company} role={role} estUsd={scopeEstimate("lite")} />
      </section>
    </PageFrame>
  );
}
