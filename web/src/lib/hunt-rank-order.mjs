/**
 * hunt: the ONE job ranking, "Best overall". Its position is the "#N" on Home, Jobs, Pipeline,
 * the Map and job pages, whatever sort is active. Pure (no fs): computed on read from
 * data/hunt-enrich.json, so it always reflects the latest evaluations and inserts.
 *
 * Order (see overallTuple): your own rating first (4-5 on top, 1-2 at the bottom), then the
 * job's one 1-5 score (the quick score, replaced by the judged decimal) in upstream's bands
 * (Strong apply / Apply / Maybe / Skip; a Staff+ title -1 band and -1 point unless its report
 * says you meet the level or you rated it yourself), then the exact score, then TC band,
 * location and freshness for exact ties. The Sonnet
 * head-to-head is only a late tie-break. At most 2 jobs per company in the top 20 and 4 in the
 * top 50 (never pushing down a job you rated 4+).
 * Posting age never demotes a job: closed jobs (data/hunt-liveness.json, scripts/hunt-liveness.mjs)
 * and skip decisions are not ranked; duplicate-group members share the leader's #,
 * except a member with its own 4.0+ evaluation, which is ranked on its own.
 */

import { tcSourceLabel } from "./hunt-tc-label.mjs";
import { staleChip } from "./hunt-job-signals.mjs";
import { SCORE_BANDS, bandForScore } from "./core/score-action.mjs";

const CLOSED = new Set(["Rejected", "Discarded", "SKIP", "Hired"]);
const TIER_NAMES = { 1: "home area", 2: "remote", 3: "NYC/Chicago", 4: "other places", 5: "remote" };

/** What the web needs from config/ranking.yml for the sorts and the caption. */
export function rankSettings(cfg = {}) {
  const loc = Object.fromEntries(Object.entries(cfg?.location_scores ?? { 1: 100, 2: 100, 3: 50, 4: 20, 5: 60 }).map(([k, v]) => [Number(k), Number(v)]));
  // jobs_judged_only: the Jobs list starts on "Judged only" (Sonnet / deep-dive scored jobs).
  return { payBasis: cfg?.pay_basis === "tc" ? "tc" : "base", locationScores: loc, judgedOnlyDefault: cfg?.jobs_judged_only === true };
}

/** "Best overall: jobs compared head-to-head on ... (home area/remote first)", for this profile. */
export function rankCaption(settings, { tournament = true } = {}) {
  const top = Math.max(...Object.values(settings.locationScores));
  const names = [...new Set(Object.entries(settings.locationScores).filter(([, v]) => v >= top - 5).map(([k]) => TIER_NAMES[k]).filter(Boolean))];
  const where = names.length ? ` (${names.join("/")} first)` : "";
  void tournament; // the head-to-head is only a last tie-break now
  return `Best overall: your ratings first, then the 1-5 score (Sonnet's decimal once judged), then pay and location${where}. # is always this rank.`;
}

export function rankable(e) {
  if (!e) return false;
  if (CLOSED.has(String(e.status ?? ""))) return false;
  if (e.closed) return false;
  if (e.excluded) return false; // the profile excludes it (exclude_contract: not full-time) // the posting URL answered expired (data/hunt-liveness.json)
  if (/^(skip|discard)/i.test(String(e.report?.decision ?? ""))) return false;
  return (e.h2h_rank != null && e.h2hVia !== "group") || typeof e.composite === "number";
}

/** Fit 1-5: the full evaluation, else the quick score; null when neither. */
export function fitValue(e) {
  return typeof e?.fit === "number" ? e.fit : typeof e?.quick_score === "number" ? e.quick_score : null;
}

/** Annual USD pay: est. TC (pay_basis tc) or the posted base midpoint, labeled. */
export function payValue(e, settings = { payBasis: "base" }) {
  if (settings.payBasis === "tc" && e?.tc_est && Number(e.tc_est.usd) > 0) return { usd: Number(e.tc_est.usd), kind: "est. TC" };
  const p = e?.pay;
  if (p && p.currency === "USD" && p.annualMin > 0) return { usd: Math.round((p.annualMin + (p.annualMax || p.annualMin)) / 2), kind: p.period === "hour" ? "hourly, annualized" : "posted base" };
  if (e?.tc_est && Number(e.tc_est.usd) > 0) return { usd: Number(e.tc_est.usd), kind: "est. TC" };
  return null;
}

/** An evaluated fit at or above this always shows (Best overall, Shortlist, Home), whatever the title level. */
export const STRONG_FIT = 4.0;

/** Missing pay counts as this (neutral: the target TC), neither rewarded nor punished. */
export const NEUTRAL_PAY_USD = 250_000;

const LOCATION_ORDER = { 1: 100, 2: 100, 5: 70, 3: 50, 4: 20 };

/** Annual USD for ranking: est. TC when there is one, else the posted base midpoint; null if unknown. */
export function rankPayUsd(e) {
  return payValue(e, { payBasis: "tc" })?.usd ?? null;
}

/**
 * Fit tiers (2026-11-22): re-running the same posting moves its fit by ~0.1-0.5, so the decimal
 * is noise. Best overall compares upstream's score bands (lib/score-action.mjs SCORE_BANDS:
 * >=4.5 Strong apply, >=4.0 Apply, >=3.0 Maybe, below Skip), not the decimal.
 */
export function fitTier(fit) {
  const f = typeof fit === "number" ? fit : Number.NaN;
  if (!Number.isFinite(f)) return -1;
  const band = bandForScore(Math.min(5, Math.max(0, f)));
  return band ? SCORE_BANDS.length - SCORE_BANDS.indexOf(band) : 0;
}

/** TC bands within a fit tier: $400k+ | $300-400k | $250-300k | $200-250k | <$200k. Missing pay = $250k band. */
export function payBand(usd) {
  const p = Number.isFinite(usd) && usd > 0 ? usd : NEUTRAL_PAY_USD;
  return p >= 400_000 ? 4 : p >= 300_000 ? 3 : p >= 250_000 ? 2 : p >= 200_000 ? 1 : 0;
}

const STAFF_KEYS = new Set(["staff", "stretch", "staffplus"]);

/** A Staff, Staff+, Principal, Lead/Architect or Senior Staff title (not "Member of Technical Staff", not "Senior/Staff"). */
export function isStaffLevel(e) {
  return STAFF_KEYS.has(e?.level?.key);
}

/**
 * A Staff+ title drops one fit band, unless its evaluation report says you meet the level
 * (report.level.meets, scripts/hunt-enrich.mjs levelAssessment) or you rated it yourself.
 * Unevaluated Staff+ jobs always drop.
 */
export function levelDrop(e) {
  return isStaffLevel(e) && !Number.isInteger(e?.my_rating) && e?.report?.level?.meets !== true;
}

/** "Stretch" on every Staff+ job (row and page), with the report's reason. */
export function stretchLabel(e) {
  if (!isStaffLevel(e)) return null;
  const lv = e.report?.level;
  const rank = Number.isInteger(e.my_rating) ? "Your rating sets its rank." : lv?.meets ? "The report says you meet the level, so it keeps its band." : lv ? "The report says the level is above your record, so it ranks one band lower." : "No evaluation yet, so it ranks one band lower.";
  return { label: "Stretch", title: `${e.level.label} title, above your Senior level. ${rank}${lv?.why ? ` Report: ${lv.why}` : ""}` };
}

/**
 * The score tier in half-tier units: a Staff+ title the report says is above your level drops a
 * full tier (-2, levelDrop). Posting age does not count. Favorite / starred companies do not count
 * either (stars are a filter, not a boost); `rankBoost` stays on the enrich
 * row only for scripts/hunt-job-filters.mjs.
 */
export function tierUnits(e) {
  return fitTier(scoreOf(e)) * 2 - (levelDrop(e) ? 2 : 0);
}

/**
 * The job's one 1-5 score: the Haiku quick score, replaced by the
 * Sonnet / deep-dive decimal once the job is judged. null when it has neither.
 */
export function scoreOf(e) {
  return typeof e?.fit === "number" ? e.fit : typeof e?.quick_score === "number" ? e.quick_score : null;
}

/**
 * The Best overall order as a tuple, compared left to right, higher first:
 *   1. your rating tier: 4-5 above everything (5 before 4), 1-2 below everything, 3 or unrated neutral
 *   2. the score band of the job's one 1-5 score (scoreOf: quick score, or the judged decimal):
 *      Staff+ below the bar -1 band (tierUnits); favorites/stars do not count
 *   3. the exact score (4.3 above 4.0; a quick 4 equals a judged 4.0; Staff below the bar -1)
 *   4. then TC band, location tier, fresher, head-to-head place, exact pay
 * Judged and unjudged jobs share one scale: an unjudged 5 ranks above a judged 4.3.
 * Missing pay is neutral (the $250k band).
 */
export function overallTuple(e) {
  const r = Number.isInteger(e.my_rating) ? e.my_rating : null;
  const tier = r != null && r >= 4 ? 1 + r : r != null && r <= 2 ? 0 : 1;
  const usd = rankPayUsd(e);
  const pay = usd ?? NEUTRAL_PAY_USD;
  const band = payBand(usd);
  const h2h = e.h2h_rank != null && e.h2hVia !== "group" ? -e.h2h_rank : -100000;
  const score = scoreOf(e);
  // The Staff rule keeps its old weight: a band down (tierUnits) and a point off the exact score,
  // so an unjudged Staff 5 still ranks like a 4, as before the one-scale change.
  const exact = score == null ? -1 : Math.round((score - (levelDrop(e) ? 1 : 0)) * 10);
  return [tier, score == null ? -100 : tierUnits(e), exact, band, LOCATION_ORDER[e.locationTier] ?? 50, -(e.postedDays ?? 0), h2h, pay, e.composite ?? 0];
}

/** Best overall comparator (sorts best first). */
export function compareOverall(a, b) {
  const x = overallTuple(a), y = overallTuple(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return String(a.url).localeCompare(String(b.url));
}

/**
 * Best overall caps each company: at most 2 jobs in the first 20 places and at most 4 in the
 * first 50. A job you rated 4+ is never pushed down by the cap (it still counts toward it).
 */
export const TOP_SPREAD = { caps: [{ n: 20, perCompany: 2 }, { n: 50, perCompany: 4 }] };

const capAt = (pos, caps) => caps.find((c) => pos < c.n)?.perCompany ?? Infinity;

/**
 * Spreads the top of an ordered list under the company caps; a job held back keeps its order
 * and takes the next place its company is allowed. The last kept job of a capped company in
 * the first cap's places gets `moreAtCompany` (how many of its jobs were moved below it).
 */
export function spreadTop(sorted, { caps = TOP_SPREAD.caps } = {}) {
  const limit = Math.max(0, ...caps.map((c) => c.n));
  const pool = [...sorted];
  const out = [], seen = new Map(), moved = new Set();
  while (out.length < limit && pool.length) {
    const cap = capAt(out.length, caps);
    let i = 0;
    for (; i < pool.length; i++) {
      const e = pool[i];
      if ((seen.get(normCo(e.company)) ?? 0) < cap || e.my_rating >= 4) break;
      moved.add(e.url);
    }
    if (i >= pool.length) break; // every remaining job is from a capped company: they follow in order
    const [e] = pool.splice(i, 1);
    const c = normCo(e.company);
    seen.set(c, (seen.get(c) ?? 0) + 1);
    out.push(moved.has(e.url) ? { ...e, movedFromTop: true } : { ...e });
  }
  const rest = pool.map((e) => (moved.has(e.url) ? { ...e, movedFromTop: true } : e));
  const firstN = caps[0]?.n ?? 0;
  const head = out.slice(0, firstN);
  for (const m of [...out.slice(firstN), ...rest].filter((e) => e.movedFromTop)) {
    const keeper = [...head].reverse().find((t) => normCo(t.company) === normCo(m.company));
    if (keeper) keeper.moreAtCompany = (keeper.moreAtCompany ?? 0) + 1;
  }
  return [...out, ...rest];
}

const normCo = (c) => String(c ?? "").trim().toLowerCase();

/** A group member with its own 4.0+ evaluation: ranked on its own, never hidden behind its leader. */
export function standsAlone(e) {
  return e?.groupLeader === false && typeof e.fit === "number" && e.fit >= STRONG_FIT && e.fitVia !== "group";
}

/**
 * Every rankable group leader (plus group members with their own 4.0+ evaluation), Best overall
 * first, each with `rank` (1-based).
 * @param {Record<string, any>} jobs url -> enrichment row
 */
export function rankedJobs(jobs) {
  const sorted = Object.entries(jobs ?? {})
    .map(([url, e]) => ({ url, ...e }))
    .filter((e) => (e.groupLeader !== false || standsAlone(e)) && rankable(e))
    .sort(compareOverall);
  return spreadTop(sorted).map((e, i) => ({ ...e, rank: i + 1 }));
}

/** url -> Best overall rank for every job, duplicate-group members carrying their leader's #. */
export function rankMap(jobs) {
  const ranked = rankedJobs(jobs);
  const out = new Map(ranked.map((e) => [e.url, e.rank]));
  const byGroup = new Map(ranked.filter((e) => e.group && e.groupLeader !== false).map((e) => [e.group, e.rank]));
  for (const [url, e] of Object.entries(jobs ?? {})) {
    if (!out.has(url) && e?.group && byGroup.has(e.group) && rankable(e)) out.set(url, byGroup.get(e.group));
  }
  return out;
}

/** Sort values for the other sorts (higher first; null last). */
export function sortValue(e, mode, settings) {
  if (!e) return null;
  if (mode === "fit") {
    const f = fitValue(e);
    return f == null ? null : f * 10 + (typeof e.fit === "number" ? 0.5 : 0); // full eval wins a tie
  }
  if (mode === "pay") return payValue(e, settings)?.usd ?? null;
  return null;
}

const kk = (n) => `${Math.round(n / 1000)}`;

/** "Rated 4/5" when the user rated the job (hunt-job-signals.mjs), else null. */
export function ratingLabel(e) {
  return Number.isInteger(e?.my_rating) ? `Rated ${e.my_rating}/5` : null;
}

/** url -> how many more of that company's jobs Best overall moved below its top 20 (spreadTop). */
export function moreAtMap(jobs) {
  return new Map(rankedJobs(jobs).filter((e) => e.moreAtCompany).map((e) => [e.url, e.moreAtCompany]));
}

/** "Fit 4.2/5" (full evaluation) or "Quick 4/5", or null. */
export function fitLabel(e) {
  if (typeof e?.fit === "number") return `Fit ${e.fit}/5`;
  if (typeof e?.quick_score === "number") return `Quick ${e.quick_score}/5`;
  return null;
}

const kband = (lo, hi) => (lo === hi ? `$${kk(lo)}k` : `$${kk(lo)}–${kk(hi)}k`);

/**
 * The pay pieces every compact pay display shares (Jobs cards, the Pipeline table's Pay column):
 *   base    "$172–280k" (yearly USD band), "$60–75/hr" (hourly), or null
 *   annual  "$125–156k" for an hourly band (annualized x2080 in the enrich row), else null
 *   tc      "~$570k TC" when there is an estimate, else null
 *   sortUsd est. TC if there is one, else the top of the annual base range, else null
 */
export function payParts(e) {
  const p = e?.pay;
  let base = null, annual = null, top = null;
  const hourly = !!p && p.period === "hour";
  if (p && p.currency === "USD" && p.min > 0) {
    if (hourly) {
      base = p.min === p.max ? `$${p.min}/hr` : `$${p.min}–${p.max}/hr`;
      if (p.annualMin > 0) annual = kband(p.annualMin, p.annualMax || p.annualMin);
    } else {
      base = kband(p.annualMin, p.annualMax);
    }
    top = Number(p.annualMax || p.annualMin) || null;
  }
  const tcUsd = e?.tc_est && Number(e.tc_est.usd) > 0 ? Number(e.tc_est.usd) : null;
  return { base, annual, hourly: hourly && base != null, ote: p?.basis === "OTE" && base != null, tc: tcUsd ? `~$${kk(tcUsd)}k TC` : null, sortUsd: tcUsd ?? top };
}

/** "$172–280k base · ~$570k TC est.", "$20–22/hr", or null when no pay is known. */
export function shortPay(e) {
  const pp = payParts(e);
  const parts = [];
  if (pp.base) parts.push(pp.hourly ? pp.base : `${pp.base} ${pp.ote ? "OTE" : "base"}`);
  if (pp.tc) parts.push(`${pp.tc} est.`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The Pipeline table's Pay cell (payParts, so it matches the Jobs cards): line 1 the posted band
 * ("$172–280k", "$172–280k OTE", hourly annualized as "$125–156k/yr hourly"), line 2 the estimate
 * ("~$570k TC"). base is "—" when nothing is known.
 */
export function payCell(e) {
  const pp = payParts(e);
  const base = pp.hourly ? (pp.annual ? `${pp.annual}/yr hourly` : `${pp.base} hourly`) : pp.base ? `${pp.base}${pp.ote ? " OTE" : ""}` : null;
  const title = [
    pp.hourly ? `Hourly ${pp.base}${pp.annual ? `, annualized ~${pp.annual}/yr` : ""}, posted` : pp.base ? `${pp.ote ? "OTE" : "Base"} ${pp.base}, posted` : null,
    pp.tc ? `Est. total comp ${pp.tc.replace(" TC", "")} (${tcSourceLabel(e.tc_est) || "estimate"})` : null,
  ].filter(Boolean).join(" · ");
  return { base: base ?? (pp.tc ? null : "—"), tc: pp.tc, sortUsd: pp.sortUsd, title: title || "Pay not listed" };
}

/** Rows by pay (dir -1 = highest first); rows with no pay always last; ties by tracker # newest first. */
export function sortByPay(rows, payOf, dir = -1) {
  const v = (r) => payOf(r)?.sortUsd ?? null;
  return [...rows].sort((a, b) => {
    const x = v(a), y = v(b);
    if (x == null && y != null) return 1;
    if (y == null && x != null) return -1;
    if (x != null && y != null && x !== y) return (x - y) * (dir === 1 ? 1 : -1);
    return Number.parseInt(String(b.n), 10) - Number.parseInt(String(a.n), 10);
  });
}

/** "Seattle area" / "Remote US" / "NYC/Chicago" from the tier, else the posting's own text. */
export function placeLabel(e) {
  const t = { 1: "Seattle area", 2: "Remote US", 3: "NYC/Chicago", 5: "Remote (global)" }[e?.locationTier];
  return t ?? (e?.location ? String(e.location).split(/[;|]/)[0].trim().slice(0, 32) : null);
}

/** The one warning chip worth showing, or null: layoffs, an unverified employer, pay below floor. */
export function warningChip(e) {
  if (e?.closed) return { label: "Closed", title: "The posting URL says this job is closed or gone" };
  if (e?.caution) return { label: "Caution: layoffs", title: "Recent layoffs at this company (research list)" };
  if (e?.identityUnverified) return { label: "Company unverified", title: "Confirm who the employer is before applying" };
  if (e?.belowFloor) return { label: "Below pay floor", title: "Posted base tops out below your floor" };
  return staleChip(e);
}
