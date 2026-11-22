// Read-only views of one profile's data, built with the dashboard's own helpers.
// Home sections (get_summary) and follow-ups (list_followups / mark_followup) come from the
// dashboard's own read-only routes, GET /api/profile/home and GET /api/profile/followups, so
// they can never drift from the pages. The rest mirrors readers in web/src/lib/hunt-data.ts
// (comments name the original). Files are read fresh per call.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadDashboard } from "./dashboard-modules.mjs";

const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };

/** Short stable id for a posting URL. */
export const jobId = (url) => "j" + crypto.createHash("sha256").update(String(url)).digest("hex").slice(0, 9);

export class ProfileData {
  constructor(profile) {
    this.p = profile;
    this.root = profile.dataDir;
    this.memo = new Map();
  }
  async M() { return loadDashboard(this.p.codeRoot); }
  file(rel) { return path.join(this.root, rel); }
  once(key, fn) {
    if (!this.memo.has(key)) this.memo.set(key, fn());
    return this.memo.get(key);
  }

  /** readHuntEnrichment */
  enrich() {
    return this.once("enrich", () => {
      const doc = readJson(this.file("data/hunt-enrich.json"), {});
      return { generatedAt: doc.generatedAt ?? null, weights: doc.weights ?? {}, jobs: doc.jobs ?? {} };
    });
  }

  /** career-ops.ts readApplications: the tracker parsed by tracker-table.mjs. */
  async applications() {
    const M = await this.M();
    return this.once("apps", () => {
      const file = M.trackerFiles.resolveTrackerPath(this.root);
      const md = readText(file);
      return md ? M.trackerTable.parseApplications(md, this.root, this.p.codeRoot) : [];
    });
  }

  async statusLog() {
    const M = await this.M();
    let text = "";
    try { text = M.trackerFiles.readTrackerFile(this.root, "status-log.tsv") ?? ""; } catch { /* dates fall back */ }
    return M.tracker.parseStatusLog(text);
  }

  /** Tracker page rows (trackerRows: every row past Evaluated). */
  async trackerRows() {
    const M = await this.M();
    return M.tracker.trackerRows(await this.applications(), await this.statusLog(), this.enrich().jobs);
  }

  /** Study: days.md + study-state.json, as Home and /study read them. */
  async study() {
    const M = await this.M();
    let state = M.study.normalizeState({});
    try { state = M.study.normalizeState(JSON.parse(readText(this.file("data/study-state.json")))); } catch { /* fresh */ }
    const doc = M.studyDays.parseDays(readText(this.file("data/study/days.md")));
    const today = M.studyDays.currentDay(doc.days, state.ticks, { fastTrack: state.fastTrack });
    const progress = M.studyDays.trackProgress(doc.days, state.ticks, { fastTrack: state.fastTrack });
    return { state, days: doc.days, today, progress };
  }

  /** readInbox + pendingInbox: postings pasted into pipeline.md and not processed yet. */
  async pendingInboxCount() {
    const M = await this.M();
    const md = readText(this.file("data/pipeline.md"));
    if (!md) return 0;
    const jobs = M.pipelineTable.parseInbox(md);
    return M.inboxPending.pendingInbox(M.inboxPending.reconcileInbox(jobs.map((j) => ({ ...j })), await this.applications())).length;
  }

  async lastScanAt() {
    const M = await this.M();
    return M.home.lastScanAt(readText(this.file("data/scan-runs.tsv")));
  }

  async weekCost() {
    const M = await this.M();
    return M.home.weekCost(readText(this.file("data/hunt-usage.tsv")));
  }

  /** templates/states.yml via the core's own loader. */
  async states() {
    const M = await this.M();
    return M.trackerUtils.loadCanonicalStates(path.join(this.p.codeRoot, "templates", "states.yml"));
  }
}
