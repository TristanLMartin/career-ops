// The dashboard's own pure helpers, imported read-only from the career-ops checkout so this
// server parses and ranks exactly the way the web UI does. Nothing here writes.
import path from "node:path";
import { pathToFileURL } from "node:url";

const cache = new Map();

const LIB = {
  tracker: "web/src/lib/hunt-tracker.mjs",
  home: "web/src/lib/hunt-home-v2.mjs",
  followups: "web/src/lib/hunt-followups.mjs",
  kinds: "web/src/lib/hunt-message-kinds.mjs",
  messagesView: "web/src/lib/hunt-messages-view.mjs",
  study: "web/src/lib/hunt-study.mjs",
  studyDays: "web/src/lib/hunt-study-days.mjs",
  trackerTable: "web/src/lib/tracker-table.mjs",
  trackerFiles: "web/src/lib/core/tracker-files.mjs",
  pipelineTable: "web/src/lib/pipeline-table.mjs",
  inboxPending: "web/src/lib/inbox-pending.mjs",
  jobPay: "web/src/lib/hunt-job-pay.mjs",
  trackerUtils: "tracker-utils.mjs",
};

export function loadDashboard(codeRoot) {
  if (!cache.has(codeRoot)) {
    const p = (async () => {
      const out = {};
      for (const [k, rel] of Object.entries(LIB)) {
        try {
          out[k] = await import(pathToFileURL(path.join(codeRoot, rel)).href);
        } catch (err) {
          throw new Error(`could not load dashboard module ${rel}: ${err.message}`);
        }
      }
      return out;
    })();
    p.catch(() => cache.delete(codeRoot));
    cache.set(codeRoot, p);
  }
  return cache.get(codeRoot);
}
