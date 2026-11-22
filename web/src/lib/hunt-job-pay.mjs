// hunt: pay line and single verdict for the job detail page.
//
// Pay is read, never computed here: the posted band and the levels.fyi-style TC estimate
// both come from data/hunt-enrich.json, written by scripts/hunt-enrich.mjs (the same
// numbers the ranking uses). This module only finds the row and formats it.

import { normalizeUrl } from "./core/url-key.mjs";
import { APPLY_LINE, flaggedPosting, legitimacyTone } from "./report-sections.mjs";

const MD_LINK = /\]\((https?:\/\/[^)\s]+)\)/;
const BARE_URL = /https?:\/\/[^\s|)]+/;

function urlOf(s) {
  const v = String(s ?? "");
  return v.match(MD_LINK)?.[1] ?? v.match(BARE_URL)?.[0] ?? "";
}

function keyOf(u) {
  const raw = urlOf(u);
  if (!raw) return "";
  try { return normalizeUrl(raw) || raw; } catch { return raw; }
}

/**
 * The enrich row for one job page: by posting URL (report URL, tracker URL or apply link,
 * also a group's member URLs), then by the tracker number the enrich row records.
 *
 * @param {Record<string, any>} jobs  data/hunt-enrich.json `jobs` (url -> row)
 * @param {{ urls?: unknown[], tracker?: string | null }} ref
 */
export function findEnrichRow(jobs, ref) {
  if (!jobs || typeof jobs !== "object") return null;
  const wanted = new Set((ref?.urls ?? []).map(keyOf).filter(Boolean));
  if (wanted.size) {
    for (const [url, row] of Object.entries(jobs)) {
      if (wanted.has(keyOf(url))) return row;
    }
    for (const row of Object.values(jobs)) {
      if ((row?.groupUrls ?? []).some((u) => wanted.has(keyOf(u)))) return row;
    }
  }
  const n = ref?.tracker == null ? "" : String(ref.tracker).replace(/^0+/, "");
  if (n) {
    for (const row of Object.values(jobs)) {
      if (row?.report?.tracker != null && String(row.report.tracker).replace(/^0+/, "") === n) return row;
    }
  }
  return null;
}

/**
 * findEnrichRow for many lookups (the Pipeline table): indexes the enrich rows once by
 * normalized URL (their key, then group member URLs) and by tracker number. Same order as
 * findEnrichRow: URL first, then the tracker number.
 */
export function enrichLookup(jobs) {
  const byUrl = new Map();
  const byTracker = new Map();
  const entries = Object.entries(jobs && typeof jobs === "object" ? jobs : {});
  for (const [url, row] of entries) {
    const k = keyOf(url);
    if (k && !byUrl.has(k)) byUrl.set(k, row);
  }
  for (const [, row] of entries) {
    for (const u of row?.groupUrls ?? []) {
      const k = keyOf(u);
      if (k && !byUrl.has(k)) byUrl.set(k, row);
    }
    const t = row?.report?.tracker;
    const n = t == null ? "" : String(t).replace(/^0+/, "");
    if (n && !byTracker.has(n)) byTracker.set(n, row);
  }
  return (ref) => {
    for (const u of ref?.urls ?? []) {
      const hit = byUrl.get(keyOf(u));
      if (hit) return hit;
    }
    const n = ref?.tracker == null ? "" : String(ref.tracker).replace(/^0+/, "");
    return (n && byTracker.get(n)) || null;
  };
}

const money = (n) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`);

function band(lo, hi, suffix = "") {
  return lo === hi ? `${money(lo)}${suffix}` : `${money(lo)}–${money(hi)}${suffix}`;
}

/** "$145,000 - $200,000/year" (the report's advertised comp) -> [145000, 200000]. */
export function parseAdvertised(s) {
  const nums = [...String(s ?? "").matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?/gi)]
    .map((m) => Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  const hourly = /\/\s*h(ou)?r|per hour|hourly/i.test(s);
  return { lo: Math.min(...nums), hi: Math.max(...nums), hourly };
}

/**
 * The pay line: the posted band, the estimated TC, both, or "Pay not listed".
 * Never invents a figure: no posted band and no estimate means not listed.
 *
 * @param {any} row  one data/hunt-enrich.json job, or null
 * @returns {{ kind: "posted" | "estimated" | "both" | "none", posted: string | null, estimated: string | null, text: string }}
 */
export function payLine(row) {
  let posted = null;
  const p = row?.pay;
  if (p && Number.isFinite(p.min) && Number.isFinite(p.max)) {
    const label = p.basis === "OTE" ? "OTE" : "Base";
    const cur = p.currency && p.currency !== "USD" ? ` ${p.currency}` : "";
    // Hourly pay is labeled as hourly, with its annualized figure (x2080) beside it.
    const fig = p.period === "hour"
      ? `${band(p.min, p.max, "/hr")} (hourly${Number.isFinite(p.annualMin) ? `, ~${band(p.annualMin, p.annualMax ?? p.annualMin, "/yr")}` : ""})`
      : band(p.annualMin ?? p.min, p.annualMax ?? p.max);
    posted = `${label} ${fig}${cur} · posted`;
  } else {
    const adv = parseAdvertised(row?.report?.advertisedComp);
    if (adv) posted = `Base ${band(adv.lo, adv.hi, adv.hourly ? "/hr" : "")} · posted`;
  }

  let estimated = null;
  const tc = row?.tc_est;
  if (tc && Number.isFinite(tc.usd) && tc.usd > 0) {
    const level = tc.levelEquiv ? `, ${tc.levelEquiv}` : "";
    const low = tc.confidence === "low" ? " (low confidence)" : "";
    estimated = `Est. total comp ~${money(tc.usd)} · levels.fyi${level}${low}`;
  }

  const kind = posted && estimated ? "both" : posted ? "posted" : estimated ? "estimated" : "none";
  const text = [posted, estimated].filter(Boolean).join(" · ") || "Pay not listed";
  return { kind, posted, estimated, text };
}

function scoreNum(score) {
  if (score == null || score === "") return null;
  const n = typeof score === "number" ? score : Number(String(score).match(/(\d+(?:\.\d+)?)/)?.[1]);
  return Number.isFinite(n) ? n : null;
}

/** Below the apply line by no more than this is a Maybe, further below is a Skip. */
export const MAYBE_MARGIN = 0.5;

/**
 * One verdict badge from one rule: the score against the apply line, plus the posting's
 * legitimacy tier as the only hard flag. The report's own Decision line is not consulted,
 * so the badge can never disagree with the score shown above it.
 *
 *   suspicious posting                       -> "Skip · posting looks suspect" (bad)
 *   score >= line, caution tier              -> "Apply · verify posting"       (warn)
 *   score >= line                            -> "Apply"                        (good)
 *   line - 0.5 <= score < line               -> "Maybe"                        (muted)
 *   score < line - 0.5                       -> "Skip"                         (muted)
 *   no score                                 -> null (no badge)
 *
 * @param {{ score?: unknown, legitimacy?: unknown, applyLine?: number }} opts
 * @returns {{ label: string, tone: "good" | "warn" | "bad" | "muted", apply: boolean } | null}
 */
export function singleVerdict({ score, legitimacy, applyLine = APPLY_LINE } = {}) {
  const n = scoreNum(score);
  const legit = String(legitimacy ?? "");
  const suspect = legit && legitimacyTone(legit) === "bad";
  if (n == null) return suspect ? { label: "Skip · posting looks suspect", tone: "bad", apply: false } : null;
  if (suspect) return { label: "Skip · posting looks suspect", tone: "bad", apply: false };
  if (n >= applyLine) {
    return flaggedPosting(legit)
      ? { label: "Apply · verify posting", tone: "warn", apply: true }
      : { label: "Apply", tone: "good", apply: true };
  }
  if (n >= applyLine - MAYBE_MARGIN) return { label: "Maybe", tone: "muted", apply: false };
  return { label: "Skip", tone: "muted", apply: false };
}
