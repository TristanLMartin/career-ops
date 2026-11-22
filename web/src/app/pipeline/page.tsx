import { Suspense } from "react";
import { pdfReadyReportNumbers, pipelineSummary, readTrackerShape, withCloseDates, type InboxJob } from "@/lib/career-ops";
import { reportNumberFromCell } from "@/lib/apply/cv-selection.mjs";
import { pendingInbox } from "@/lib/inbox-pending.mjs";
import { PipelineView } from "@/components/pipeline-view";
import { pipelineTab } from "@/lib/pipeline-navigation.mjs";
import { scorePosting } from "@/lib/core/inbox-rank.mjs";
import { applyInboxFit, loadFitTargets } from "@/lib/inbox-fit-profile.mjs";
import { readHuntEnrichment } from "@/lib/hunt-data"; // hunt: rank badges
import { AddJobBox } from "@/components/hunt/add-job-box"; // hunt
import { JobsViewToggle } from "@/components/hunt/jobs-view-toggle"; // hunt: List | Map

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
  const enrich = onInbox ? readHuntEnrichment().jobs : {};
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
    fitted.jobs = fitted.jobs.map((job) => ({ ...job, hunt: enrich[job.url] ?? null }));
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
      {onInbox && <div className="mx-auto max-w-3xl px-4 pt-3 sm:px-6"><AddJobBox /></div>}
      <PipelineView
        applications={applications}
        inbox={fitted ? fitted.jobs : null}
        inboxCount={pending.length}
        inboxFitError={fitted?.error ?? null}
        trackerShape={trackerShape}
        cvRows={cvRows}
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
