/**
 * hunt: a stable first_seen_at per job URL, set once and never overwritten
 * (data/first-seen.json). Home's "New since you last looked" compares it with the last visit.
 *
 * Backfill, once per URL, from the earliest evidence:
 *   - data/scan-history.tsv first_seen (a local date). For today's rows the date alone would say
 *     midnight, so they take the time of the scan run that added them: scan.mjs appends history
 *     rows in run order and data/scan-runs.tsv records each run's new_added count, so today's
 *     "added" rows map onto today's runs in sequence.
 *   - a tracker row's Date column (local date)
 *   - otherwise `now` (enrich runs right after each scan, so that is the ingest time).
 */
import fs from "node:fs";
import path from "node:path";

/** Local midnight of a YYYY-MM-DD date, as ISO (UTC). */
export function localMidnight(day) {
  const [y, m, d] = String(day).split("-").map(Number);
  return new Date(y, m - 1, d).toISOString();
}

export function localDay(t) {
  const d = new Date(t);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
}

/**
 * url -> ISO first-seen from scan history + runs.
 * historyTsv: data/scan-history.tsv. runsTsv: data/scan-runs.tsv. today: YYYY-MM-DD (local).
 */
export function historyFirstSeen(historyTsv, runsTsv, today) {
  const out = new Map();
  const lines = String(historyTsv ?? "").split("\n");
  const head = (lines[0] ?? "").split("\t");
  const ui = head.indexOf("url"), fi = head.indexOf("first_seen"), si = head.indexOf("status");
  if (ui < 0 || fi < 0) return out;
  // today's runs, oldest first, as a queue of {at, left}
  const rl = String(runsTsv ?? "").split("\n");
  const rh = (rl[0] ?? "").split("\t");
  const ti = rh.indexOf("timestamp"), ni = rh.indexOf("new_added");
  const runs = rl.slice(1).map((l) => l.split("\t")).filter((c) => c[ti] && localDay(Date.parse(c[ti])) === today && Number(c[ni]) > 0)
    .map((c) => ({ at: new Date(Date.parse(c[ti])).toISOString(), left: Number(c[ni]) }))
    .sort((a, b) => a.at.localeCompare(b.at));
  let r = 0;
  for (const l of lines.slice(1)) {
    const c = l.split("\t");
    const url = c[ui], day = c[fi];
    if (!url || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) continue;
    let at = localMidnight(day);
    if (day === today && (si < 0 || c[si] === "added")) {
      while (r < runs.length && runs[r].left <= 0) r++;
      if (r < runs.length) { at = runs[r].at; runs[r].left--; }
    }
    const prev = out.get(url);
    if (!prev || at < prev) out.set(url, at);
  }
  return out;
}

/**
 * Add a first-seen time for every URL that has none; never change an existing one.
 * Returns { doc, added }.
 */
export function assignFirstSeen(doc, urls, { history = new Map(), trackerDates = new Map(), now = Date.now() } = {}) {
  const jobs = { ...(doc?.jobs ?? {}) };
  let added = 0;
  const nowIso = new Date(now).toISOString();
  for (const u of urls) {
    if (jobs[u]) continue;
    const cands = [history.get(u), trackerDates.has(u) ? localMidnight(trackerDates.get(u)) : null].filter(Boolean);
    jobs[u] = cands.length ? cands.sort()[0] : nowIso;
    if (jobs[u] > nowIso) jobs[u] = nowIso;
    added++;
  }
  return { doc: { jobs, updatedAt: nowIso }, added };
}

/** Read, update and atomically write data/first-seen.json for these URLs. */
export function updateFirstSeen(root, urls, { trackerDates = new Map(), now = Date.now() } = {}) {
  const file = path.join(root, "data", "first-seen.json");
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch { doc = { jobs: {} }; }
  const missing = urls.filter((u) => !doc.jobs?.[u]);
  if (!missing.length) return { added: 0 };
  let history = new Map();
  try {
    history = historyFirstSeen(fs.readFileSync(path.join(root, "data", "scan-history.tsv"), "utf8"), fs.readFileSync(path.join(root, "data", "scan-runs.tsv"), "utf8"), localDay(now));
  } catch { /* no history yet: ingest time */ }
  const { doc: next, added } = assignFirstSeen(doc, urls, { history, trackerDates, now });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, file);
  return { added };
}
