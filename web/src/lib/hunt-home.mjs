/**
 * Pure numbers for the home page. Mirrors topPicks() in
 * lib/hunt-rank.mjs (the web tree imports nothing outside web/).
 */

export const DEFAULT_TOP_PICKS = Object.freeze({ min_fit: 3.8, min_level: 0.7, per_company: 3, limit: 10 });
export const STATUS_ORDER = Object.freeze(["Evaluated", "Applied", "Responded", "Assessment", "Interview", "Offer", "Hired", "Rejected", "Discarded", "SKIP"]);
const CLOSED = new Set(["Rejected", "Discarded", "SKIP", "Hired"]);

/**
 * @param {Record<string, any>} jobs  data/hunt-enrich.json `jobs`
 * @param {{ min_fit?: number, min_level?: number, per_company?: number, limit?: number }} [cfg]
 */
export function topPicks(jobs, cfg = {}) {
  const c = { ...DEFAULT_TOP_PICKS, ...cfg };
  const per = new Map();
  const out = [];
  const ranked = Object.entries(jobs ?? {})
    .map(([url, e]) => ({ url, ...e }))
    .filter((e) => e.fit != null && e.fitVia !== "group" && e.fit >= c.min_fit && (e.level?.factor ?? 1) >= c.min_level && typeof e.composite === "number")
    .filter((e) => !CLOSED.has(String(e.status ?? "")) && !/^(skip|discard)/i.test(String(e.report?.decision ?? "")))
    .filter((e) => e.groupLeader !== false && !e.belowFloor)
    // True rank: Sonnet head-to-head order first (top ~100), composite below.
    .sort((a, b) => (a.h2h_rank ?? 1e9) - (b.h2h_rank ?? 1e9) || b.composite - a.composite || b.fit - a.fit);
  for (const e of ranked) {
    const n = per.get(e.company) ?? 0;
    if (n >= c.per_company) continue;
    per.set(e.company, n + 1);
    out.push(e);
    if (out.length >= c.limit) break;
  }
  return out;
}

/** Unscored postings, by composite: the "Not scored yet" group. */
export function notScoredYet(jobs, limit = 10) {
  return Object.entries(jobs ?? {})
    .map(([url, e]) => ({ url, ...e }))
    .filter((e) => e.fit == null && e.source === "inbox" && typeof e.composite === "number" && e.groupLeader !== false)
    .sort((a, b) => b.composite - a.composite)
    .slice(0, limit);
}

/** Tracker counts by canonical status, in pipeline order. */
export function statusCounts(applications) {
  const counts = new Map();
  for (const a of applications ?? []) {
    const s = String(a.status ?? "").trim() || "—";
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const known = STATUS_ORDER.filter((s) => counts.has(s)).map((s) => [s, counts.get(s)]);
  const other = [...counts.entries()].filter(([s]) => !STATUS_ORDER.includes(s));
  return [...known, ...other];
}

/**
 * New roles in the last 24h from data/scan-runs.tsv, excluding the very first run
 * (the initial backfill). Returns { newRoles, backfillOnly }.
 * @param {string} tsv
 */
export function newRolesSince(tsv, now = Date.now(), hours = 24) {
  const lines = String(tsv ?? "").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return { newRoles: 0, backfillOnly: lines.length > 0 };
  const header = lines[0].split("\t");
  const ti = header.indexOf("timestamp");
  const ni = header.indexOf("new_added");
  const rows = lines.slice(1).map((l) => l.split("\t")).filter((c) => c[ti]);
  rows.sort((a, b) => a[ti].localeCompare(b[ti]));
  const since = now - hours * 3600 * 1000;
  let n = 0;
  for (const r of rows.slice(1)) {
    const t = Date.parse(r[ti]);
    if (Number.isFinite(t) && t >= since) n += Number(r[ni]) || 0;
  }
  return { newRoles: n, backfillOnly: rows.length === 1 };
}

export function ageLabel(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const h = Math.floor((now - t) / 3600000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}
