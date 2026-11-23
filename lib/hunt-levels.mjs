// Total comp from Levels.fyi's official MCP server (free tier), per company and internal level
//. Pure functions; scripts/hunt-levels-refresh.mjs fetches the data into
// data/comp-levels.json.
//
// data/comp-levels.json:
//   { fetchedAt, source, jobFamily, companies: { <normCompany>: {
//       name, slug, public: bool|null, fetchedAt,
//       locations: { "<home location slug>": [level...], "united-states": [level...] } } } }
//   level = { level, secondaryLevelName?, medianTotalCompensation, p10TotalCompensation,
//             p90TotalCompensation, averageBaseSalary, averageStockPerYear, averageBonus }
//   Levels are in the company's seniority order (Levels.fyi returns them that way).
//
// Which level a posting maps to (pickLevel):
//   1. a level named in the title ("Forward Deployed Engineer LMTS", "Senior MTS", "L5");
//   2. otherwise by the title's seniority (lib/hunt-rank.mjs levelFit): Senior and untitled
//      roles use the company's Senior/E5 equivalent from config/comp.json level_equiv,
//      else the first level named "Senior"; Mid is one below; Staff is the level named "Staff",
//      else one above; Staff+ two above.
//   3. no match: no estimate (never a guess).
// Location: config/ranking.yml `levels.home_location` (a Levels.fyi location slug, e.g. a metro
// such as "greater-austin-area") is used for home-metro and remote rows (location tiers 1 and 2);
// without it, or when the home metro has no data, US-wide data is used. US data for a home row
// is scaled by `tc_home.factor` (default 1, no change), the same factor the research table uses.
// Private-company stock counts x 0.6 in the ranked figure.

import { normCompany, compFor, estimateTc, PRIVATE_EQUITY_FACTOR, HOME_TC_FACTOR } from "./hunt-comp.mjs";

export const US = "united-states";
export const LEVELS_SOURCE = "levels.fyi";

const SENIORITY_WORD = /\b(senior|sr|staff|lead|principal|distinguished|junior|associate|entry|intern)\b/i;
const CODE_LEVEL = /^(?:[a-z]{1,3}\s?-?\d{1,2}[a-z]?|\d{2})$/i; // L5, E5, IC3, T5, P40, 63
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (s) => String(s ?? "").toLowerCase().replace(/member of (the )?technical staff/g, "mts").replace(/[^a-z0-9+]+/g, " ").trim();

/** "Lead MTS" -> "lmts", "Senior MTS" -> "smts": the compact form some titles use. */
function initials(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length !== 2 || !/^[A-Z]{2,4}$/.test(parts[1])) return null;
  return (parts[0][0] + parts[1]).toLowerCase();
}

/** Level names a title may mention explicitly: code-like, seniority-worded, or compact initials. */
function titleTokens(lv) {
  const out = [];
  for (const name of [lv.level, lv.secondaryLevelName].filter(Boolean)) {
    if (CODE_LEVEL.test(name.trim()) || SENIORITY_WORD.test(name)) out.push(words(name));
    const ini = initials(name);
    if (ini) out.push(ini);
  }
  return out.filter(Boolean);
}

/** Index of the level the title names outright, longest match first; -1 when none. */
export function levelInTitle(levels, title) {
  const t = ` ${words(title)} `;
  let best = -1, bestLen = 0;
  levels.forEach((lv, i) => {
    for (const tok of titleTokens(lv)) {
      if (tok.length > bestLen && new RegExp(` ${escapeRe(tok)} `).test(t)) { best = i; bestLen = tok.length; }
    }
  });
  return best;
}

/** "Lead MTS (~E5; SMTS ~E4)" -> "Lead MTS"; "L3 (Senior)" -> "L3". */
export function levelEquivName(levelEquiv) {
  const s = String(levelEquiv ?? "").split(/[(;,]/)[0].trim();
  return s && !/^(unknown|n\/a|none)$/i.test(s) ? s : null;
}

const findIdx = (levels, re) => levels.findIndex((lv) => re.test(lv.level) || re.test(lv.secondaryLevelName ?? ""));

/** Names a curated level_equiv can stand for: "L6 (SDE III)" -> ["L6", "SDE III"]. */
function equivNames(levelEquiv) {
  const s = String(levelEquiv ?? "");
  const first = levelEquivName(s);
  const paren = /\(([^)~;,]+)\)/.exec(s)?.[1]?.trim();
  return [first, paren].filter((x) => x && !/^(senior|senior swe|unknown)$/i.test(x));
}

/** The company's Senior/E5-equivalent level index, or -1. */
export function seniorIndex(levels, levelEquiv) {
  const names = equivNames(levelEquiv).map((n) => n.toLowerCase());
  if (names.length) {
    for (const n of names) {
      const i = levels.findIndex((lv) => lv.level.toLowerCase() === n || String(lv.secondaryLevelName ?? "").toLowerCase() === n);
      if (i >= 0) return i;
    }
  }
  // A level named Senior, but never Senior Principal / Senior Staff / Senior Director and the like.
  const ABOVE = /\b(staff|principal|distinguished|director|fellow|architect|lead)\b/i;
  return levels.findIndex((lv) => [lv.level, lv.secondaryLevelName ?? ""].some((n) => /\b(senior|sr)\b/i.test(n) && !ABOVE.test(n)));
}

/**
 * Picks the level for one posting. `levelKey` is levelFit's key (senior | mid | dual | stretch |
 * staff | staffplus). Returns { index, how } or null.
 */
export function pickLevel(levels, { title = "", levelKey = "senior", levelEquiv = null } = {}) {
  if (!Array.isArray(levels) || !levels.length) return null;
  const named = levelInTitle(levels, title);
  if (named >= 0) return { index: named, how: "title" };
  const s = seniorIndex(levels, levelEquiv);
  const at = (i, how) => (i >= 0 && i < levels.length ? { index: i, how } : null);
  switch (levelKey) {
    case "mid": return s > 0 ? at(s - 1, "below senior") : null;
    case "staff":
    case "stretch": {
      const st = findIdx(levels, /\bstaff\b(?!.*\b(senior|sr)\b)/i);
      return st >= 0 ? at(st, "staff") : s >= 0 ? at(s + 1, "above senior") : null;
    }
    case "staffplus": return s >= 0 ? at(s + 2, "two above senior") : null;
    default: {
      const eq = equivNames(levelEquiv).map((n) => n.toLowerCase());
      const named = s >= 0 && eq.some((n) => levels[s].level.toLowerCase() === n || String(levels[s].secondaryLevelName ?? "").toLowerCase() === n);
      return s >= 0 ? at(s, named ? "senior equivalent" : "senior") : null;
    }
  }
}

/** Map<normCompany, record> from data/comp-levels.json. */
export function loadLevelsDoc(doc) {
  const map = new Map();
  for (const [k, v] of Object.entries(doc?.companies ?? {})) if (v && v.locations) map.set(k, v);
  return map;
}

/** Exact normalized name only: the refresh stores each pipeline company under its own name. */
export function levelsFor(company, map) {
  if (!map?.size) return null;
  const key = normCompany(company);
  return (key && map.get(key)) || null;
}

/**
 * TC estimate for one posting from the company's Levels.fyi levels, in the shape estimateTc
 * returns (lib/hunt-comp.mjs) plus level / where / parts. Null without a usable level.
 */
/** "greater-austin-area" -> "Greater Austin Area". */
export function locationLabel(slug) {
  return String(slug ?? "").split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

export function estimateFromLevels(rec, { title = "", levelKey = "senior", levelEquiv = null, locationTier = null, publicEquity = null, homeLocation = null, homeFactor = HOME_TC_FACTOR } = {}) {
  if (!rec?.locations) return null;
  const homeRow = (locationTier === 1 || locationTier === 2) && Boolean(homeLocation);
  const tryLoc = (loc) => {
    const levels = rec.locations[loc];
    const pick = pickLevel(levels, { title, levelKey, levelEquiv });
    const lv = pick ? levels[pick.index] : null;
    return lv && Number.isFinite(lv.medianTotalCompensation) ? { loc, pick, lv } : null;
  };
  const hit = (homeRow ? tryLoc(homeLocation) : null) ?? tryLoc(US);
  if (!hit) return null;
  const { loc, pick, lv } = hit;
  const geo = homeRow && loc !== homeLocation && Number(homeFactor) > 0 ? Number(homeFactor) : 1;
  const isPublic = rec.public ?? publicEquity ?? false;
  const stock = Number.isFinite(lv.averageStockPerYear) ? lv.averageStockPerYear : 0;
  const raw = lv.medianTotalCompensation * geo;
  const adjusted = isPublic ? raw : (lv.medianTotalCompensation - stock * (1 - PRIVATE_EQUITY_FACTOR)) * geo;
  const round = (v) => Math.round(v / 1000) * 1000;
  const spread = lv.p10TotalCompensation > 0 ? lv.p90TotalCompensation / lv.p10TotalCompensation : null;
  // high: home-metro data at a level the title or the curated equivalent names; medium: US-wide
  // data, a generic "Senior" match or a neighbour level; low: a very wide p10-p90 spread.
  let confidence = loc !== US && ["title", "senior equivalent"].includes(pick.how) ? "high" : "medium";
  if (spread != null && spread > 2.2) confidence = "low";
  const where = loc === US ? "US" : locationLabel(loc);
  return {
    usd: round(raw),
    rankUsd: round(adjusted),
    basis: `${where} median at ${lv.level}`,
    homeAdjusted: geo !== 1,
    privateEquity: !isPublic,
    confidence,
    range: lv.p10TotalCompensation && lv.p90TotalCompensation ? [round(lv.p10TotalCompensation * geo), round(lv.p90TotalCompensation * geo)] : null,
    equityType: isPublic ? "public RSU" : "private equity",
    levelEquiv: lv.level,
    level: lv.level,
    levelHow: pick.how,
    where,
    parts: { base: round(lv.averageBaseSalary * geo), stock: round(stock * geo), bonus: round((lv.averageBonus ?? 0) * geo) },
    source: `${LEVELS_SOURCE} (${where}, ${lv.level})`,
    fetchedAt: rec.fetchedAt ?? null,
  };
}

/**
 * The TC estimate one posting gets: Levels.fyi's own per-level data when it has the company and
 * a level matches, else the research table (config/comp.json), else null.
 */
export function bestTcEstimate({ company, title = "", levelKey = "senior", pay = null, locationTier = null }, { levelsMap = new Map(), compMap = new Map(), homeLocation = null, homeFactor = HOME_TC_FACTOR } = {}) {
  const entry = compFor(company, compMap);
  const fromLevels = estimateFromLevels(levelsFor(company, levelsMap), { title, levelKey, levelEquiv: entry?.levelEquiv ?? null, locationTier, publicEquity: entry ? entry.publicEquity : null, homeLocation, homeFactor });
  return fromLevels ?? estimateTc(entry, pay, { locationTier, homeFactor });
}
