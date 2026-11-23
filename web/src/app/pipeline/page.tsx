import { Suspense } from "react";
import { pdfReadyReportNumbers, pipelineSummary, readTrackerShape, withCloseDates, type InboxJob } from "@/lib/career-ops";
import { reportNumberFromCell } from "@/lib/apply/cv-selection.mjs";
import { pendingInbox } from "@/lib/inbox-pending.mjs";
import { PipelineView } from "@/components/pipeline-view";
import { pipelineTab } from "@/lib/pipeline-navigation.mjs";
import { scorePosting } from "@/lib/core/inbox-rank.mjs";
import { applyInboxFit, loadFitTargets } from "@/lib/inbox-fit-profile.mjs";
import { readRankSettings, readHuntEnrichment } from "@/lib/hunt-data"; // hunt: rank badges
import { moreAtMap, payCell, payValue, rankCaption, rankMap } from "@/lib/hunt-rank-order.mjs"; // hunt: Best overall
import { enrichLookup } from "@/lib/hunt-job-pay.mjs"; // hunt: Pay column
import { AddJobBox } from "@/components/hunt/add-job-box"; // hunt
import { JobsViewToggle } from "@/components/hunt/jobs-view-toggle"; // hunt: List | Map
import { InProgressLane, type InProgressRow } from "@/components/hunt/in-progress-lane"; // hunt: pinned lane
import { readApplicationStatusLog } from "@/lib/career-ops";
import { parseStatusLog, trackerRows } from "@/lib/hunt-tracker.mjs";
import { inProgress } from "@/lib/hunt-home-v2.mjs";

export const dynamic = "force-dynamic"; // always read fresh local files

// Tracker tabs show the inbox only as a count, so they get the count and not
// the postings. The inbox is most of the page payload on a large pipeline.
export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  const onInbox = pipelineTab(tab) === "INBOX";
  const summary = pipelineSummary();
  const applications = await withCloseDates(summary.applications);
  const { inbox } = summary;
  const pending = pendingInbox(inbox);
  // hunt: fit-scored Shortlist postings leave the pending inbox once evaluated, but the
  // Shortlist ranks scored roles first, so they rejoin the triage list (marked done).
  // hunt: Best overall (#N) for both tabs: inbox cards and tracker rows.
  const enrich = readHuntEnrichment().jobs;
  const rankSet = readRankSettings();
  const ranks = rankMap(enrich);
  const moreAt = moreAtMap(enrich); // hunt: "+N more at Company" under the top-20 cap
  const hasTournament = Object.values(enrich).some((e) => e?.h2h_rank != null && e?.h2hVia !== "group");
  const caption = rankCaption(rankSet, { tournament: hasTournament });
  const appRanks: Record<string, number> = {};
  for (const [url, e] of Object.entries(enrich)) {
    const n = e?.report?.tracker;
    const r = ranks.get(url);
    if (n != null && r != null && (appRanks[String(n)] == null || r < appRanks[String(n)])) appRanks[String(n)] = r;
  }
  // hunt: the tracker table's Pay column, from the same enrich row the job page reads.
  const appPay: Record<string, ReturnType<typeof payCell>> = {};
  if (!onInbox) {
    const lookup = enrichLookup(enrich);
    for (const a of applications) {
      const e = lookup({ urls: [a.url], tracker: a.n });
      if (e) appPay[String(a.n)] = payCell(e);
    }
  }
  const pendingUrls = new Set(pending.map((j) => j.url));
  const seenScored = new Set<string>();
  const scoredShortlist = onInbox
    ? inbox.filter((j) => {
        const t = enrich[j.url];
        if (!j.done || pendingUrls.has(j.url) || seenScored.has(j.url) || t?.fit == null || !t.groupShortlist) return false;
        seenScored.add(j.url);
        return true;
      })
    : [];
  const fitted = onInbox ? withInboxFit([...pending, ...scoredShortlist]) : null;
  if (fitted) {
    // hunt: a posting whose URL answered expired is Closed and leaves the Jobs list.
    fitted.jobs = fitted.jobs.filter((job) => !enrich[job.url]?.closed && !enrich[job.url]?.excluded).map((job) => {
      const e = enrich[job.url];
      if (!e) return { ...job, hunt: null };
      const pv = payValue(e, rankSet);
      return { ...job, hunt: { ...e, rankNo: ranks.get(job.url) ?? null, moreAt: moreAt.get(job.url) ?? null, payUsd: pv?.usd ?? null, payKind: pv?.kind ?? null } };
    });
  }
  // hunt: the "In progress" lane pinned above the ranked Jobs list (Applied … Offer).
  let progress: InProgressRow[] = [];
  if (onInbox) {
    let logText = "";
    try { logText = readApplicationStatusLog() ?? ""; } catch { /* dates fall back to the tracker */ }
    progress = inProgress(trackerRows(summary.applications, parseStatusLog(logText), enrich)) as InProgressRow[];
  }
  const trackerShape = readTrackerShape();
  // Tracker row numbers whose tailored CV is indexed (data/pdf-index.tsv) AND on
  // disk; the tracker's own PDF emoji can drift from what output/ really holds.
  // Rows are keyed the way /api/cv-pdf?application= resolves them: through the
  // report cell, so a row with no resolvable report never gets a dead link.
  // Skipped on the inbox tab, which has no table.
  // One manifest read for the whole table, not one per row (#6974: per-row
  // lookups took 8 s on a 5,000-row tracker).
  const cvRows: string[] = [];
  if (!onInbox) {
    const rowReports = applications.flatMap((a) => {
      const report = reportNumberFromCell(a.report);
      return report !== null && report > 0 ? [{ n: a.n, report }] : [];
    });
    const ready = await pdfReadyReportNumbers(new Set(rowReports.map((r) => r.report)));
    for (const r of rowReports) if (ready.has(r.report)) cvRows.push(r.n);
  }
  return (
    <Suspense>
      <div className="mx-auto flex max-w-3xl justify-end px-4 pt-6 sm:px-6"><JobsViewToggle active="list" /></div>
      {onInbox && <InProgressLane rows={progress} />}
      {onInbox && <div className="mx-auto max-w-3xl px-4 pt-3 sm:px-6"><AddJobBox /></div>}
      <PipelineView
        applications={applications}
        inbox={fitted ? fitted.jobs : null}
        inboxCount={pending.length}
        inboxFitError={fitted?.error ?? null}
        trackerShape={trackerShape}
        cvRows={cvRows}
        appRanks={appRanks}
        appPay={appPay}
        rankCaption={caption}
      />
    </Suspense>
  );
}

function withInboxFit(jobs: InboxJob[]): { jobs: InboxJob[]; error: string | null } {
  return applyInboxFit(jobs, loadFitTargets, (job, targets) => ({
    ...job,
    fit: scorePosting({
      title: job.role,
      location: job.location ?? "",
      pay: job.compensation ?? "",
      rankStamp: job.rankStamp ?? null,
    }, targets),
  }));
}
