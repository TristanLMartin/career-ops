// Total-comp estimates and the company factor for the ranking.
//
// config/comp.json: an array, one entry per company (levels.fyi-style research, senior IC):
//   { "company": "Stripe", "level_equiv": "L3 (Senior)", "tc_median_usd": 460000, "tc_range_usd": null,
//     "base_usd": 218000, "stock_per_year_usd": 221000, "bonus_usd": 21400,
//     "equity_type": "private RSU/options" | "public RSU" | "options" | "unknown",
//     "location_basis": "US national (levels.fyi, no metro split)", "source_urls": [...],
//     "confidence": "high" | "medium" | "low", "stage": "public" | "late-private" | "growth" | "early",
//     "stability_note": "...", "company_tier": 1-4 }
// A { companies: {...} } map is accepted too.
//
// Rules (research brief target-roles-brief-2026-11):
// - Raw est. TC is shown in the UI. Ranking uses a liquidity-adjusted TC:
//   base + bonus + stock x 1.0 for public RSUs, x 0.6 for private RSUs/options/PPUs.
// - TC drives the pay part only at high/medium confidence with 2+ data points; otherwise the
//   posting's base midpoint does (the UI still shows the low-confidence estimate).
// - Figures are national and Bay-weighted: ranking.yml tc_home.factor (default 1, no change) scales
//   home-metro (tier 1) rows unless the basis names your metro (tc_home.basis_words).
// - Non-US-only bases (Singapore, Canada, EU, India...) and "no data" give no estimate.
// - Company part: tier 1/2/3/4 = 1.0/0.8/0.55/0.3, minus 0.1 for a 2026 layoff; unknown 0.6.
//
// Nothing here changes the live ranking by itself: config/ranking.yml must set
// `pay_basis: tc` and a `weights.company` above 0.

const CONFIDENCE_RANK = { low: 1, medium: 2, high: 3 };
export const DEFAULT_TC_BAND = Object.freeze({ floor: 200000, ceiling: 550000 });
export const PRIVATE_EQUITY_FACTOR = 0.6;
/** Default home-metro TC factor: none. A profile sets ranking.yml tc_home.factor (e.g. 0.9). */
export const HOME_TC_FACTOR = 1;
export const MIN_SCALE = 0.8;
export const MAX_SCALE = 1.25;
const TIER_FACTOR = { 1: 1.0, 2: 0.8, 3: 0.55, 4: 0.3 };
export const UNKNOWN_COMPANY_SCORE = 60;
const LAYOFF_RE = /\b(layoffs?|laid off|rifs?|reductions? in force|job cuts|cut \d+%? of (staff|employees|workforce)|restructur\w*)\b/i;
const NO_LAYOFF_RE = /\bno (major |recent |reported )?(2026 )?(layoffs?|rifs?)\b/i;
const NON_US_BASIS_RE = /\b(singapore|canada|spain|netherlands|greece|india|uk|united kingdom|europe|eu)\b[^;]*\bonly\b|^\s*no data\s*$|\bno us data\b/i;
/** Words that mark a comp row as already measured in your metro (tc_home.basis_words). */
function homeBasisRe(words) {
  const list = [].concat(words ?? []).map((w) => String(w).trim()).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return list.length ? new RegExp(`\\b(${list.join("|")})\\b`, "i") : /(?!)/;
}
const SINGLE_POINT_RE = /\b(1|one|single) data point\b/i;

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Normalized company key: lowercase, no punctuation, no "(YC W19)"-style tags or Inc./LLC/Technologies suffixes. */
export function normCompany(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[,.&'’]/g, " ")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|technology|industries|labs|ai|hq|systems?)\b/g, " ")
    .replace(/\s+/g, "")
    .trim();
}

/** Normalizes the research file into Map<normalized company, entry>. Unknown shapes give an empty map. */
export function loadCompDoc(doc, { homeWords = [] } = {}) {
  const HOME_BASIS_RE = homeBasisRe(homeWords);
  const map = new Map();
  if (!doc || typeof doc !== "object") return map;
  const list = Array.isArray(doc) ? doc
    : Array.isArray(doc.companies) ? doc.companies
    : doc.companies && typeof doc.companies === "object" ? Object.entries(doc.companies).map(([company, v]) => ({ company, ...v }))
    : [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || !raw.company) continue;
    const r = raw.tc_range_usd;
    const range = Array.isArray(r) ? r.map(num) : r && typeof r === "object" ? [num(r.low ?? r.min), num(r.high ?? r.max)] : [null, null];
    const basis = String(raw.location_basis ?? "");
    const sources = Array.isArray(raw.source_urls) ? raw.source_urls.filter(Boolean) : [];
    const equityType = raw.equity_type ? String(raw.equity_type) : null;
    const entry = {
      company: String(raw.company),
      levelEquiv: raw.level_equiv ?? null,
      tcMedian: num(raw.tc_median_usd),
      tcRange: range[0] != null && range[1] != null && range[0] <= range[1] ? [range[0], range[1]] : null,
      base: num(raw.base_usd ?? raw.base_median_usd ?? raw.base),
      stock: num(raw.stock_per_year_usd ?? raw.stock_usd ?? raw.stock),
      bonus: num(raw.bonus_usd ?? raw.bonus),
      equityType,
      publicEquity: /public/i.test(equityType ?? "") || (/^public$/i.test(String(raw.stage ?? "")) && !/private|option/i.test(equityType ?? "")),
      locationBasis: basis || null,
      usBasis: !NON_US_BASIS_RE.test(basis),
      // "no <metro> split", "(hq ...)" and "<metro> office exists" notes do not make a metro basis.
      homeBasis: HOME_BASIS_RE.test(basis.replace(/no [a-z/ ]+ split|[a-z/ ]+ office exists|\bhq [a-z/ ]+|\(hq [^)]*\)|[a-z/ ]+ close to us figure/gi, "")),
      singlePoint: SINGLE_POINT_RE.test(basis) || sources.length === 0,
      confidence: CONFIDENCE_RANK[String(raw.confidence ?? "").toLowerCase()] ? String(raw.confidence).toLowerCase() : "low",
      stage: raw.stage ?? null,
      stabilityNote: raw.stability_note ?? null,
      tier: [1, 2, 3, 4].includes(Number(raw.company_tier)) ? Number(raw.company_tier) : null,
    };
    map.set(normCompany(entry.company), entry);
  }
  return map;
}

/** Exact normalized match, then a prefix match either way (e.g. "Andurilindustries" -> "Anduril"), 4+ chars. */
export function compFor(company, compMap) {
  if (!compMap?.size) return null;
  const key = normCompany(company);
  if (!key) return null;
  if (compMap.has(key)) return compMap.get(key);
  let best = null;
  for (const [k, e] of compMap) {
    if (k.length < 4) continue;
    if ((key.startsWith(k) || k.startsWith(key)) && key.length >= 4 && (!best || k.length > best[0].length)) best = [k, e];
  }
  return best ? best[1] : null;
}

/**
 * Estimated TC for one posting. Raw: the company's TC median, scaled by the posting's base
 * midpoint over the company's base when both exist (clamped to the company range), times
 * `homeFactor` for a home-metro (tier 1) row when the research basis isn't that metro. Ranked: the same with stock
 * discounted to 0.6 for private equity. Null when the company has no usable US figure.
 */
export function estimateTc(entry, pay, { locationTier = null, homeFactor = HOME_TC_FACTOR } = {}) {
  if (!entry || entry.tcMedian == null || !entry.usBasis) return null;
  const mid = pay && pay.basis !== "OTE" && pay.currency === "USD" ? (pay.annualMin + pay.annualMax) / 2 : null;
  // The base ratio is clamped to 0.8-1.25: stock and bonus don't move 1:1 with a posted
  // band, and many entries have no TC range to clamp the result to.
  const scale = mid && entry.base ? Math.max(MIN_SCALE, Math.min(MAX_SCALE, mid / entry.base)) : 1;
  const geo = locationTier === 1 && !entry.homeBasis && Number(homeFactor) > 0 ? Number(homeFactor) : 1;
  const clamp = (v) => (entry.tcRange && mid && entry.base ? Math.max(entry.tcRange[0], Math.min(entry.tcRange[1], v)) : v);
  const raw = clamp(entry.tcMedian * scale) * geo;
  // Liquidity-adjusted: rebuild from the parts when we have them, else discount the stock share
  // implied by the median.
  let adjusted = raw;
  if (!entry.publicEquity) {
    const stock = entry.stock ?? (entry.base != null ? Math.max(0, entry.tcMedian - entry.base - (entry.bonus ?? 0)) : null);
    if (stock != null) adjusted = clamp((entry.tcMedian - stock * (1 - PRIVATE_EQUITY_FACTOR)) * scale) * geo;
  }
  const round = (v) => Math.round(v / 1000) * 1000;
  const lowConfidence = entry.confidence === "low" || entry.singlePoint;
  return {
    usd: round(raw),
    rankUsd: round(adjusted),
    basis: mid && entry.base ? "scaled by posting base" : "company median",
    homeAdjusted: geo !== 1,
    privateEquity: !entry.publicEquity,
    confidence: lowConfidence ? "low" : entry.confidence,
    range: entry.tcRange,
    equityType: entry.equityType,
    levelEquiv: entry.levelEquiv,
    source: "levels.fyi-style estimate",
  };
}

export function confidenceAtLeast(c, min = "medium") {
  return (CONFIDENCE_RANK[c] ?? 0) >= (CONFIDENCE_RANK[min] ?? 2);
}

/** 0-100 on the TC band (default $200k -> 0, $550k -> 100). */
export function tcScore(usd, band = DEFAULT_TC_BAND) {
  if (usd == null) return null;
  return Math.max(0, Math.min(100, Math.round(((usd - band.floor) / (band.ceiling - band.floor)) * 100)));
}

/** True when the stability note reports a 2026 layoff (and doesn't say there was none). */
export function recentLayoff(note) {
  const s = String(note ?? "");
  if (!s || NO_LAYOFF_RE.test(s)) return false;
  return LAYOFF_RE.test(s) && /2026/.test(s);
}

/** Company part (0-100): tier factor x 100, minus 10 for a 2026 layoff; unknown company 60. */
export function companyScore(entry) {
  if (!entry || entry.tier == null) return UNKNOWN_COMPANY_SCORE;
  const s = TIER_FACTOR[entry.tier] * 100 - (recentLayoff(entry.stabilityNote) ? 10 : 0);
  return Math.max(0, Math.min(100, Math.round(s)));
}

/** UI line: "base $X–Y · est. TC ~$Z (medium confidence, private equity)". */
export function formatPayWithTc(pay, tc) {
  const k = (n) => `$${Math.round(n / 1000)}k`;
  const base = pay ? (pay.annualMin === pay.annualMax ? `base ${k(pay.annualMin)}` : `base ${k(pay.annualMin)}–${k(pay.annualMax).slice(1)}`) : null;
  const est = tc ? `est. TC ~${k(tc.usd)} (${[`${tc.confidence} confidence`, tc.privateEquity ? "private equity" : null].filter(Boolean).join(", ")})` : null;
  return [base, est].filter(Boolean).join(" · ") || null;
}
