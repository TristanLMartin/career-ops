// hunt: reads Home's inputs for the current profile (careerOpsRoot()) and builds its sections
// with homeSections(). Shared by <HuntHome/> and GET /api/profile/home.
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, readApplications, readApplicationStatusLog } from "@/lib/career-ops";
import { readFollowupRows, readInbox, readThreadRows, readHuntEnrichment } from "@/lib/hunt-data";
import { parseStatusLog, trackerRows } from "@/lib/hunt-tracker.mjs";
import { homeSections, lastVisitFrom } from "@/lib/hunt-home-v2.mjs";

/** data/first-seen.json jobs (url -> ISO), written by hunt-enrich.mjs. */
function readFirstSeen(root: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(path.join(root, "data", "first-seen.json"), "utf8")).jobs ?? {}; } catch { return {}; }
}

/** The last visit, read only: it is recorded by <HomeVisit/> after 10 s on Home or on leaving. */
function readLastVisit(root: string): string | null {
  try { return lastVisitFrom(JSON.parse(fs.readFileSync(path.join(root, "data", "home-last-visit.json"), "utf8"))); } catch { return null; }
}

export function loadHomeSections(root: string = careerOpsRoot()) {
  const enrich = readHuntEnrichment(root);
  const applications = readApplications();
  let logText = "";
  try { logText = readApplicationStatusLog() ?? ""; } catch { /* dates fall back to the tracker */ }
  const tracker = trackerRows(applications, parseStatusLog(logText), enrich.jobs);
  const { rows: threads } = readThreadRows(root);
  const followups = readFollowupRows(root, threads);
  // "Needs you" is the Inbox's "Needs my reply" (plus new top postings), so the two agree.
  let inboxNeeds: unknown[] | null = null;
  try { inboxNeeds = readInbox(root).needs; } catch { /* fall back to the older per-thread rows */ }
  return { root, enrich, applications, ...homeSections({ tracker, threads, followups, jobs: enrich.jobs, firstSeen: readFirstSeen(root), lastVisit: readLastVisit(root), inboxNeeds }) };
}
