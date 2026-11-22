// hunt: Tracker — one spreadsheet-style view of every job in flight (status past Evaluated).
// Reads the same tracker the Jobs list reads (data/applications.md + data/status-log.tsv);
// edits go through /api/status → set-status.mjs, the single write path.
import { PageFrame } from "@/components/page-frame";
import { readApplications, readApplicationStatusLog } from "@/lib/career-ops";
import { readHuntEnrichment } from "@/lib/hunt-data";
import { parseStatusLog, trackerRows } from "@/lib/hunt-tracker.mjs";
import { TrackerView, type TrackerRow } from "@/components/hunt/tracker-view";

export const dynamic = "force-dynamic";

export default function TrackerPage() {
  const apps = readApplications();
  let logText = "";
  try { logText = readApplicationStatusLog() ?? ""; } catch { /* unreadable ledger: dates fall back to the tracker */ }
  const rows = trackerRows(apps, parseStatusLog(logText), readHuntEnrichment().jobs) as TrackerRow[];
  return (
    <PageFrame width="wide">
      <h1 className="font-display text-2xl tracking-tight text-landing">Tracker</h1>
      <p className="mt-1 text-sm text-muted">Every job you have applied to or are talking to. Change a status or the next step right in the table.</p>
      <TrackerView rows={rows} />
    </PageFrame>
  );
}
