import { notFound } from "next/navigation";
import { readReport, findApplication, trackerCanDelete } from "@/lib/career-ops";
import { resolveTailoredCover } from "@/lib/apply/cover";
import { ReportView } from "@/components/report-view";
import { pipelineQuery } from "@/lib/pipeline-navigation.mjs";
import { reportNumberFor } from "@/lib/apply-checklist.mjs";
import { readCvDiskState } from "@/lib/read-cv-disk";
import { parseReport } from "@/lib/format";
import { missingTrackedJob } from "@/lib/job-route.mjs";
import { readHuntEnrichment } from "@/lib/hunt-data";
import { rankMap, stretchLabel } from "@/lib/hunt-rank-order.mjs";
import { StretchBadge, WhyThisRank } from "@/components/hunt/rank-badges";
import { JobRating } from "@/components/hunt/job-rating"; // hunt: your 1-5 rating
import type { HuntEnrichment } from "@/lib/hunt-types";
import { findEnrichRow, payLine } from "@/lib/hunt-job-pay.mjs";

export const dynamic = "force-dynamic";

export default async function ReportPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = pipelineQuery(await searchParams);
  const app = findApplication(id);
  const report = readReport(id);
  if (missingTrackedJob({ hasApplication: !!app, hasReport: !!report })) notFound();
  // Resolved here rather than in the component so the link is only rendered when
  // THIS application's cover is actually on disk. `id` is passed as the
  // application number, never as a company: a report with no tracker row has no
  // identity to match on, and guessing one from the id would surface another
  // offer's cover.
  const coverReady = (await resolveTailoredCover(app?.company, id)) !== null;
  // Same name the View link puts in ?company=, so a slug match here is the file that link would open.
  const companyName = app?.company || parseReport(report?.content ?? "").title || "";
  const reportNum = reportNumberFor(id, app, report?.file ?? null);
  const disk = await readCvDiskState(id, companyName, (app?.pdf ?? "").includes("✅"), reportNum);
  const pdfFileReady = disk.exists;
  // hunt: pay line from the ranking's own data (posted band + levels.fyi-style TC estimate).
  const reportUrl = parseReport(report?.content ?? "").fields.find((f) => f.label === "URL")?.value;
  const enrichJobs = readHuntEnrichment().jobs;
  const row = findEnrichRow(enrichJobs, { urls: [reportUrl, app?.url, app?.applyLink], tracker: app?.n ?? null });
  const pay = payLine(row);
  // hunt: Best overall rank (#N, the same number everywhere) and "Why this rank".
  const rowUrl = row ? Object.keys(enrichJobs).find((u) => enrichJobs[u] === row) ?? null : null;
  const rank = rowUrl ? rankMap(enrichJobs).get(rowUrl) ?? null : null;
  const rankSlot = row ? { rank, why: <>{stretchLabel(row as HuntEnrichment) && <div className="mb-2 flex items-center gap-2 text-xs text-muted"><StretchBadge e={row as HuntEnrichment} /><span>{stretchLabel(row as HuntEnrichment)!.title}</span></div>}{rowUrl && <div className="mb-2"><JobRating url={rowUrl} rating={(row as HuntEnrichment).my_rating ?? null} note={(row as HuntEnrichment).my_rating_note ?? (row as HuntEnrichment).my_rating_said ?? null} /></div>}<WhyThisRank e={row as HuntEnrichment} rank={rank} /></> } : null;
  return (
    <ReportView
      id={id}
      app={app}
      report={report?.content ?? null}
      file={report?.file ?? null}
      canDelete={trackerCanDelete()}
      pdfFileReady={pdfFileReady}
      applyPdfReady={disk.applyPdfReady}
      trackerMarkedPdf={(app?.pdf ?? "").includes("✅")}
      coverReady={coverReady}
      backHref={`/pipeline${query ? `?${query}` : ""}`}
      applyHref={`/pipeline/${encodeURIComponent(id)}/apply${query ? `?${query}` : ""}`}
      reportNum={reportNum}
      pay={pay}
      rankSlot={rankSlot}
    />
  );
}
