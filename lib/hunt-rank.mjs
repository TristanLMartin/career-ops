// Ranking helpers. Pure functions, no I/O,
// so they can be unit-tested and reused by scripts/hunt-enrich.mjs.
// Kept in its own file so upstream career-ops updates merge cleanly.

export const DEFAULT_WEIGHTS = Object.freeze({ fit: 35, relevance: 20, pay: 10, location: 15, benefits: 5, level: 15 });

// Nothing about a person, field or city is assumed here: every role-, place- and level-specific
// rule comes from the profile's config/ranking.yml (`profile_rules`, `level`, `target`). The
// presets in presets/<name>/config/ranking.yml are complete examples (swe, recruiting, generic).
//
// Companies where the top of the IC ladder is a real step up (level.big_companies). Empty by default.
export const DEFAULT_BIG_COMPANIES = Object.freeze([]);
// Domains where a one-step-up title is a reasonable stretch (profile_rules.level.stretch_words).
let STRETCH_DOMAIN_RE = /(?!)/;
export const DEFAULT_PAY_BAND = Object.freeze({ floor: 150000, ceiling: 350000 });
export const LOCATION_TIER_SCORE = Object.freeze({ 1: 100, 2: 85, 3: 50, 4: 20, 5: 70 });

// Tier 1 = home metro (profile_rules.location.home), 3 = secondary metros (location.secondary).
// Both never match until a profile sets them.
let HOME = /(?!)/;
const REMOTE_US = /remote/i;
let SECONDARY = /(?!)/;
const NON_US_REMOTE = /remote[^·;|]{0,25}\b(canada|uk|united kingdom|europe|eu|emea|apac|india|latam|global|worldwide|anywhere)\b|\b(global|worldwide)\b[^·;|]{0,10}remote/i;

/** 1 = home metro, 2 = remote (US), 3 = secondary metro, 4 = other, 5 = remote (global). */
export function locationTier(location) {
  const loc = String(location ?? "");
  if (!loc.trim()) return null;
  if (HOME.test(loc)) return 1;
  if (REMOTE_US.test(loc) && !(NON_US_REMOTE.test(loc) && !/\b(us|usa|united states|u\.s\.)\b/i.test(loc))) return 2;
  // "Remote, Global" / worldwide: open to the US but not US-specific (5 = Remote, global).
  if (REMOTE_US.test(loc) && /\b(global|worldwide|anywhere)\b/i.test(loc)) return 5;
  if (SECONDARY.test(loc)) return 3;
  return 4;
}

const HOURS_PER_YEAR = 2080;

function toNumber(raw, kSuffix) {
  const n = Number(String(raw).replace(/[,\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  return kSuffix ? n * 1000 : n;
}

/**
 * Parse a stored comp cell ("200000-280000 USD") or free text from a job
 * description ("$185,000 - $300,000", "$90/hr", "$150K–$200K").
 * Returns { min, max, currency, period, annualMin, annualMax } or null.
 */
export function parsePay(text) {
  const s = String(text ?? "");
  if (!s.trim()) return null;
  const cell = s.match(/^\s*(\d[\d,.]*)\s*(?:-|–|to)\s*(\d[\d,.]*)\s*([A-Z]{3})\s*$/);
  let min, max, currency, period;
  if (cell) {
    min = toNumber(cell[1]);
    max = toNumber(cell[2]);
    currency = cell[3];
  } else {
    const range = s.match(/(US\$|CA\$|\$|USD\s?|CAD\s?)\s?(\d[\d,]*(?:\.\d+)?)\s*([kK])?\s*(?:USD|CAD)?\s*(?:-|–|—|to)\s*(?:US\$|CA\$|\$|USD\s?|CAD\s?)?\s?(\d[\d,]*(?:\.\d+)?)\s*([kK])?\s*(USD|CAD)?/);
    if (!range) return null;
    min = toNumber(range[2], !!range[3]);
    max = toNumber(range[4], !!range[5] || (!!range[3] && Number(String(range[4]).replace(/,/g, "")) < 1000));
    const cur = `${range[1]} ${range[6] ?? ""}`;
    currency = /CA|CAD/.test(cur) ? "CAD" : "USD";
    const after = s.slice(range.index + range[0].length, range.index + range[0].length + 40);
    if (/^\s*(?:\/|per|an|a)\s*(?:hour|hr)\b/i.test(after) || /\/\s*h(?:ou)?r/i.test(range[0])) period = "hour";
  }
  if (min == null || max == null || min <= 0 || max < min) return null;
  if (!period) period = max < 1000 ? "hour" : "year";
  const mult = period === "hour" ? HOURS_PER_YEAR : 1;
  const annualMin = Math.round(min * mult);
  const annualMax = Math.round(max * mult);
  // Ignore implausible annual values (equity totals, sign-on bonuses, typos).
  if (annualMax < 30000 || annualMin > 2000000 || annualMax > 3000000) return null;
  return { min, max, currency, period, annualMin, annualMax };
}

/** 0-100 from the annual midpoint across the configured band. CAD is scaled down roughly. */
export function payScore(pay, band = DEFAULT_PAY_BAND) {
  if (!pay) return null;
  const fx = pay.currency === "CAD" ? 0.72 : 1;
  const mid = ((pay.annualMin + pay.annualMax) / 2) * fx;
  const pct = ((mid - band.floor) / (band.ceiling - band.floor)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

export const BENEFIT_PATTERNS = Object.freeze({
  k401_match: /401\s?\(?k\)?[^.]{0,80}\bmatch|match(?:ing)?[^.]{0,60}401\s?\(?k\)?/i,
  equity: /\b(equity|RSUs?|restricted stock|stock options?|ownership stake)\b/i,
  remote_stipend: /\b(home[- ]office|remote[- ]work|work[- ]from[- ]home|wfh)\b[^.]{0,40}\b(stipend|allowance|budget|reimburse)/i,
  parental_leave: /\b(parental|maternity|paternity|family)\s+leave\b/i,
  health_full: /\b100\s?%[^.]{0,60}\b(medical|health|premiums?)\b|\b(medical|health)[^.]{0,60}\b100\s?%/i,
  bonus: /\b(annual|performance|target|signing|sign-on)\s+bonus\b|\bbonus(?:es)?\b/i,
});

export function benefitFlags(text) {
  const s = String(text ?? "");
  if (!s.trim()) return null;
  const flags = {};
  for (const [k, re] of Object.entries(BENEFIT_PATTERNS)) flags[k] = re.test(s);
  return flags;
}

export function benefitScore(flags) {
  if (!flags) return null;
  const vals = Object.values(flags);
  return Math.round((vals.filter(Boolean).length / vals.length) * 100);
}

const STOP = new Set(["and", "or", "the", "a", "an", "of", "for", "to", "in", "on", "with", "non", "firm", "senior", "staff", "sr"]);

function tokens(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s/-]/g, " ")
    .split(/[\s/-]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t && !STOP.has(t));
}

/** Build keyword targets from profile.yml (parsed object) and cv.md text. */
export function relevanceTargets(profile, cvText) {
  const roles = [
    ...(profile?.target_roles?.primary ?? []),
    ...((profile?.target_roles?.archetypes ?? []).map((a) => a?.name).filter(Boolean)),
  ];
  const rolePhrases = roles.map((r) => [...new Set(tokens(r))]).filter((t) => t.length);
  const skills = new Set();
  const skillLines = String(cvText ?? "").match(/^\s*-\s*\*\*[^*]+:\*\*.*$/gm) ?? [];
  for (const line of skillLines) {
    const list = line.replace(/^\s*-\s*\*\*[^*]+:\*\*/, "");
    for (const item of list.split(",")) {
      const k = item.trim().toLowerCase().replace(/\s*\(.*\)$/, "");
      if (k && k.length >= 2 && k.length <= 30 && !/circumnavigat/.test(k)) skills.add(k);
    }
  }
  return { rolePhrases, skills: [...skills] };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 0-100. Title: best fraction of a target role's words present (60 pts).
 * Description: distinct CV skills mentioned, 10 = full marks (40 pts).
 * Without a description the title alone is scaled to 100.
 */
export function relevanceScore(title, description, targets) {
  const tt = new Set(tokens(title));
  let best = 0;
  for (const phrase of targets.rolePhrases) {
    const hit = phrase.filter((w) => tt.has(w) || (w === "full" && tt.has("fullstack")) || (w === "backend" && tt.has("back"))).length;
    best = Math.max(best, hit / phrase.length);
  }
  const titlePts = best * 60;
  const desc = String(description ?? "");
  if (!desc.trim()) return Math.round(best * 100);
  let skillHits = 0;
  for (const sk of targets.skills) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(sk)}($|[^a-z0-9])`, "i");
    if (re.test(desc)) skillHits++;
  }
  return Math.round(titlePts + Math.min(skillHits, 10) * 4);
}

/** "4.1/5" → 4.1 */
export function parseFit(scoreCell) {
  const m = String(scoreCell ?? "").match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  return m ? Number(m[1]) : null;
}

/** Weighted composite 0-100; missing parts are dropped and the rest renormalized. */
export function composite(parts, weights = DEFAULT_WEIGHTS) {
  let num = 0;
  let den = 0;
  for (const [k, w] of Object.entries(weights)) {
    const v = parts[k];
    if (v == null || !Number.isFinite(v) || !(w > 0)) continue;
    num += v * w;
    den += w;
  }
  return den ? Math.round((num / den) * 10) / 10 : null;
}

// company_boost in config/ranking.yml: flat composite points for favorite
// companies (case-insensitive name match), capped at 100.
export function companyBoost(company, boosts = {}) {
  const key = String(company ?? "").trim().toLowerCase();
  for (const [name, pts] of Object.entries(boosts ?? {})) {
    if (name.trim().toLowerCase() === key && Number.isFinite(Number(pts))) return Number(pts);
  }
  return 0;
}

export function boostedComposite(parts, weights, boost = 0) {
  const c = composite(parts, weights);
  return c == null ? null : Math.min(100, Math.round((c + boost) * 10) / 10);
}

export function fitToPct(fit) {
  return fit == null ? null : Math.max(0, Math.min(100, ((fit - 1) / 4) * 100));
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Level fit. With `opts.rules` (ranking.yml profile_rules.level.rules) the first rule whose words
 * appear in the title wins, else `opts.defaultLevel`, so any field can describe its own ladder.
 * Without rules this is the built-in IC ladder (target = Senior IC), used by the swe preset.
 * Returns { key, label, factor } where factor is 0-1.
 *  senior     1.0  Senior/Sr/Senior+, or no level stated
 *  mid        0.85 plain "Software Engineer" at a big company, or an explicit I/II/1/2 level
 *  dual       0.7  both levels in the title ("Senior / Staff", "Staff + Sr.")
 *  stretch    0.7  Staff at a mid-size company in payments/fraud/checkout/billing/real-time/messaging
 *  staff      0.45 Staff elsewhere
 *  staffplus  0.25 Senior Staff, Staff+, Principal, Distinguished, Lead, Architect (not Solutions Architect)
 * Any title with "Staff" (other than Member of Technical Staff) ranks below Senior.
 */
export function levelFit(title, company = "", description = "", opts = {}) {
  if (Array.isArray(opts.rules)) return ruleLevel(title, opts.rules, opts.defaultLevel);
  const big = new Set((opts.bigCompanies ?? DEFAULT_BIG_COMPANIES).map(norm));
  // "Member of Technical Staff" is not a Staff title, and "Solution(s) Architect" is a role, not a level.
  const t = String(title ?? "").replace(/member of (the )?technical staff/gi, "MTS").replace(/\bsolutions?\s+architect\b/gi, "Solutions Role");
  const factors = { senior: 1, mid: 0.85, dual: 0.7, stretch: 0.7, staff: 0.45, staffplus: 0.25, ...(opts.factors ?? {}) };
  const out = (key, label) => ({ key, label, factor: factors[key] });
  // "Sr. Staff" / "Sr Staff" is Senior Staff (Staff+), not a Senior-or-Staff dual title.
  const seniorStaff = /\b(senior|sr\.?)\s+staff\b/i.test(t);
  const staffPlus = /\bstaff\s*\+(?!\s*(senior|sr)\b)/i.test(t);
  const hasStaff = /\bstaff\b/i.test(t);
  const hasSenior = /\b(senior|sr)\b\.?/i.test(t.replace(/\b(senior|sr\.?)\s+staff\b/gi, ""));
  if (seniorStaff || staffPlus || /\bprincipal\b|\bdistinguished\b|\b(tech(nical)?\s+)?lead\b|\barchitect\b/i.test(t)) {
    if (!(hasSenior && !seniorStaff && !staffPlus && !hasStaff)) return out("staffplus", "Staff+");
  }
  if (hasStaff && hasSenior) return out("dual", "Senior/Staff");
  if (hasStaff) {
    const domain = STRETCH_DOMAIN_RE.test(t) || STRETCH_DOMAIN_RE.test(String(description ?? "").slice(0, 4000));
    return !big.has(norm(company)) && domain ? out("stretch", "Staff (stretch)") : out("staff", "Staff");
  }
  if (hasSenior) return out("senior", "Senior");
  if (/\b(engineer|developer)\s+(i{1,2}|[12])\b/i.test(t)) return out("mid", "Mid");
  if (big.has(norm(company)) && /\bsoftware (engineer|developer)\b/i.test(t) && !/\bfounding\b/i.test(t)) return out("mid", "Mid");
  return out("senior", "Senior");
}

/** A configured ladder: [{ key, label, words: [...], factor }], first match wins. */
export function ruleLevel(title, rules, fallback) {
  const t = String(title ?? "");
  for (const r of rules) {
    if (!r || !r.key) continue;
    if (wordsRe(r.words).test(t)) return { key: String(r.key), label: String(r.label ?? r.key), factor: Number.isFinite(Number(r.factor)) ? Number(r.factor) : 1 };
  }
  const d = fallback ?? {};
  return { key: String(d.key ?? "target"), label: String(d.label ?? "Target level"), factor: Number.isFinite(Number(d.factor)) ? Number(d.factor) : 1 };
}

/**
 * ranking.yml `target`: which roles count as "on target" for the Shortlist, auto-scoring and the
 * head-to-head. levels: level keys allowed (null = any); location_tiers: allowed tiers;
 * always_companies: companies that pass the location check anyway; exclude_titles: words that
 * take a title off target.
 */
export const DEFAULT_TARGET = Object.freeze({ levels: null, location_tiers: [1, 2, 5], always_companies: [] });
export function normalizeTarget(t) {
  if (t && t.tiers && t.always) return t;
  const o = t && typeof t === "object" ? t : {};
  const levels = Array.isArray(o.levels) && o.levels.length ? o.levels.map(String) : null;
  const tiers = Array.isArray(o.location_tiers) && o.location_tiers.length ? o.location_tiers.map(Number) : [...DEFAULT_TARGET.location_tiers];
  const always = new Set([].concat(o.always_companies ?? []).map((c) => String(c).trim().toLowerCase()).filter(Boolean));
  const exclude = [].concat(o.exclude_titles ?? []).filter(Boolean).length ? wordsRe(o.exclude_titles) : null;
  return { levels, tiers, always, exclude };
}
/** Level on target; a job with no level computed counts as on target. */
export function levelOnTarget(e, target) {
  const t = normalizeTarget(target);
  return !t.levels || !e?.level?.key || t.levels.includes(e.level.key);
}
export function placeOnTarget(e, target) {
  const t = normalizeTarget(target);
  return t.tiers.includes(e?.locationTier) || t.always.has(String(e?.company ?? "").trim().toLowerCase());
}
export function onTarget(e, target) {
  const t = normalizeTarget(target);
  if (t.exclude && t.exclude.test(String(e?.displayRole ?? e?.role ?? ""))) return false;
  return levelOnTarget(e, t) && placeOnTarget(e, t);
}

/**
 * Confident top picks: fit-scored only, fit >= minFit, level >= minLevel, sorted by
 * composite, at most perCompany per company. `jobs` is [url, enrichment] pairs.
 */
export function topPicks(jobs, { minFit = 3.8, minLevel = 0.7, perCompany = 3, limit = 10, exclude = new Set() } = {}) {
  const per = new Map();
  const out = [];
  const ranked = jobs
    .filter(([url, e]) => !exclude.has(url) && e && e.fit != null && e.fit >= minFit && (e.level?.factor ?? 1) >= minLevel && typeof e.composite === "number")
    .sort((a, b) => b[1].composite - a[1].composite || b[1].fit - a[1].fit);
  for (const [url, e] of ranked) {
    const n = per.get(e.company) ?? 0;
    if (n >= perCompany) continue;
    per.set(e.company, n + 1);
    out.push([url, e]);
    if (out.length >= limit) break;
  }
  return out;
}

// ---- pay: pick the right band from a job description -----------------------

const HIGH_COST_RE = /\b(seattle|washington|wa|new york|nyc|ny|san francisco|sf|bay area|california|ca|pacific|zone 1|tier 1|tier one|zone a)\b/i;
const NON_US_RE = /\b(canada|canadian|cad|uk|united kingdom|london|toronto|vancouver|europe|eur|gbp|ireland|dublin|india|mexico|brazil)\b|£|€/i;
const OTE_RE = /\b(ote|on[- ]target earnings|total (target )?compensation|total comp)\b/i;
const LEVEL_LABEL_RE = /(^|\s)(I|L|E|IC|P|M)\s?\d\b/;
const RANGE_RE = /((?:US|CA|C|AU|A|NZ|SG)?\$)\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d+)?\s?[kK])\s*(?:USD|CAD)?\s*(?:-|–|—|to)\s*(?:(?:US|CA|C|AU|A|NZ|SG)?\$)?\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d+)?\s?[kK])/g;

function money(raw) {
  const s = String(raw).replace(/\s/g, "");
  if (/k$/i.test(s)) return Math.round(parseFloat(s) * 1000);
  return Number(s.replace(/,/g, ""));
}

/**
 * All USD annual ranges in a JD with the 160 characters before each, then the band
 * for the job: a band whose context names a high-cost US location (Seattle, NYC, SF,
 * WA/NY/CA, Zone 1) wins; level-labeled bands (I4/I5/I6...) take the middle one;
 * otherwise the highest US band. Returns parsePay()'s shape plus basis/source/bands.
 */
export function payFromDescription(text) {
  // Some board caches keep dashes as (double-)escaped entities ("$186,065&amp;mdash;$218,900").
  const s = String(text ?? "").replace(/&(?:amp;)*(?:mdash|ndash|#821[12]|#x201[34]);/gi, " — ").replace(/&(?:amp;)*nbsp;/gi, " ");
  const bands = [];
  let prevEnd = 0;
  for (const m of s.matchAll(RANGE_RE)) {
    const min = money(m[2]);
    const max = money(m[3]);
    const start = Math.max(prevEnd, m.index - 120);
    prevEnd = m.index + m[0].length;
    if (!(min >= 30000 && max >= min && max <= 3000000)) continue;
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 30);
    if (/^\s*(?:\/|per|an|a)\s*(?:hour|hr)\b/i.test(after)) continue;
    // Context = text since the previous range (so one band's label never leaks into the next).
    const near = s.slice(start, m.index) + (m[1] !== "$" && m[1] !== "US$" ? " CAD" : "");
    bands.push({ min, max, near, highCost: HIGH_COST_RE.test(near), nonUS: NON_US_RE.test(near) || /^\s*(CAD|GBP|EUR)/.test(after), ote: OTE_RE.test(near + after), level: LEVEL_LABEL_RE.test(near.slice(-12)) });
  }
  const us = bands.filter((b) => !b.nonUS);
  if (!us.length) return null;
  let pick;
  const high = us.filter((b) => b.highCost);
  const levels = us.filter((b) => b.level);
  if (high.length) pick = high.reduce((a, b) => (b.max > a.max ? b : a));
  else if (levels.length >= 3) pick = levels[Math.floor(levels.length / 2)];
  else pick = us.reduce((a, b) => (b.max > a.max ? b : a));
  return {
    min: pick.min, max: pick.max, currency: "USD", period: "year", annualMin: pick.min, annualMax: pick.max,
    basis: pick.ote ? "OTE" : "base",
    band: pick.highCost ? "high-cost US" : levels.length >= 3 ? "level band" : us.length > 1 ? "highest US band" : "only band",
    bands: us.length,
  };
}

// ---- relevance from the profile's own words (profile_rules.relevance) ---------------
// Empty until a profile sets them; enrich then falls back to relevanceScore() (target roles in
// config/profile.yml + the CV's skill lines). presets/swe/config/ranking.yml is a full example.

export let DOMAINS = Object.freeze({});
export let LANGUAGES = Object.freeze([]);
let TITLE_FAMILY_RE = /(?!)/;
let TITLE_STRONG_RE = /(?!)/g;
let TITLE_OFF_RE = /(?!)/;

/** True once a profile has relevance words configured (otherwise relevanceV2 has nothing to go on). */
export function hasRelevanceRules() {
  return Object.keys(DOMAINS).length > 0 || LANGUAGES.length > 0 || TITLE_FAMILY_RE.source !== "(?!)" || TITLE_STRONG_RE.source !== "(?!)";
}

function hitsOf(re, text) {
  const set = new Set();
  for (const m of String(text ?? "").matchAll(re)) set.add(m[0].toLowerCase());
  return set;
}

/**
 * 0-100 relevance against the profile's configured words (profile_rules.relevance). Title: role family (20) + strong domain words (up to 25) - off-target
 * (-25). Description: domain matches weighted (payments/real-time above generic
 * platform words, up to 45) + languages (up to 10). No description: title only, scaled.
 */
export function relevanceV2(title, description = "") {
  const t = String(title ?? "");
  let titlePts = TITLE_FAMILY_RE.test(t) ? 20 : 0;
  titlePts += Math.min(25, hitsOf(TITLE_STRONG_RE, t).size * 12);
  if (TITLE_OFF_RE.test(t)) titlePts -= 25;
  const d = String(description ?? "");
  // Title only (no description): capped at 80 so a bare title can't outrank a real JD match.
  if (!d.trim()) return Math.max(0, Math.min(80, Math.round((titlePts / 45) * 80)));
  let domainPts = 0;
  const matched = [];
  for (const [name, { weight, re }] of Object.entries(DOMAINS)) {
    const n = hitsOf(re, d).size;
    if (n === 0) continue;
    const pts = n >= 3 ? weight : n === 2 ? weight * 0.75 : weight * 0.4;
    domainPts += pts;
    matched.push(name);
  }
  domainPts = Math.min(45, domainPts);
  const langs = LANGUAGES.filter((l) => new RegExp(`(^|[^a-z0-9])${l}($|[^a-z0-9+#])`, "i").test(d)).length;
  const langPts = Math.min(10, langs * 2);
  return Math.max(0, Math.min(100, Math.round(titlePts + domainPts + langPts)));
}

export function relevanceDomains(description = "") {
  return Object.entries(DOMAINS).filter(([, { re }]) => hitsOf(re, description).size >= 2).map(([k]) => k);
}

// ---- duplicate groups ---------------------------------------------------------

const LEVEL_WORDS_RE = /\b(senior|sr|staff|principal|lead|junior|jr|mid|i{1,3}|iv|v|[1-6]|\+)\b\.?/gi;
const CITY_RE = /\b(seattle|bellevue|redmond|kirkland|new york|nyc|chicago|san francisco|sf|remote|us|usa|united states|austin|boston|denver|atlanta|london|toronto)\b/gi;

// Role family: near-identical titles at one company collapse onto one family, so team and
// location variants ("Senior Software Engineer, Minecraft" / "Software Engineer II - XBOX")
// group together, while a different discipline stays apart.
const FAMILIES = [
  ["fde", /\b(forward[- ]deployed|fde|deployment (engineer|strategist))\b/i],
  ["solutions", /\b(solutions?|sales|customer|field)\s+(engineer|architect|consultant)\b|\bsolutions? (engineering|architecture)\b/i],
  ["sre", /\b(site reliability|sre|production engineer)\b/i],
  ["ml", /\b(machine learning|ml|research) (engineer|scientist)\b|\bresearch(er)?\b|\bscientist\b/i],
  ["applied-ai", /\b(applied ai|ai|llm|genai|agents?)\s+(engineer|developer)\b/i],
  ["data-eng", /\bdata (engineer|engineering)\b/i],
  ["swe", /\b(software|swe|sde|developer|engineer|engineering|programmer|mts|member of (the )?technical staff)\b/i],
];
// Disciplines that make a real difference to fit; any of them anywhere in the title.
const DISCIPLINES = [
  ["backend", /\bback[- ]?end\b|\bserver[- ]side\b/i],
  ["fullstack", /\bfull[- ]?stack\b/i],
  ["frontend", /\bfront[- ]?end\b|\bui engineer\b|\bweb (engineer|developer)\b/i],
  ["mobile", /\b(mobile|ios|android|react native)\b/i],
  ["payments", /\b(payments?|billing|checkout|fraud|risk|ledger|money|treasury|lending|banking)\b/i],
  ["realtime", /\b(real[- ]?time|messaging|calling|voice|video|webrtc|streaming media)\b/i],
  ["infra", /\b(infrastructure|infra|cloud|kubernetes|compute|storage|networking|distributed systems?|systems|reliability|fleet|datacenter|data center|hpc|gpu)\b/i],
  ["platform", /\bplatforms?\b/i],
  ["data", /\b(data|analytics|database|warehouse|pipelines?)\b/i],
  ["observability", /\b(observability|telemetry|logging|monitoring|tracing)\b/i],
  ["devtools", /\b(developer (tools|productivity|experience)|dev ?tools|devex|engineering productivity|build|ci\/?cd|compilers?|tooling)\b/i],
  ["ai", /\b(ai|ml|llm|genai|inference|agents?|agentic|copilot|machine learning|model)\b/i],
  ["security", /\b(security|identity|auth|privacy|trust (&|and) safety)\b/i],
  ["embedded", /\b(embedded|firmware|kernel|drivers?|hardware|silicon|fpga|asic|avionics|flight software|gnc)\b/i],
  ["game", /\b(game(play)?|xbox|graphics|rendering)\b/i],
];

/** Title -> { family, disciplines } used by groupKey (exported for tests and the UI). */
export function roleShape(title) {
  let t = String(title ?? "").replace(/member of (the )?technical staff/gi, "MTS");
  const family = (FAMILIES.find(([, re]) => re.test(t)) ?? ["other"])[0];
  const disciplines = DISCIPLINES.filter(([, re]) => re.test(t)).map(([d]) => d).filter((d) => !(family === "applied-ai" && d === "ai") && !(family === "data-eng" && d === "data"));
  return { family, disciplines };
}

/**
 * company | role family | sorted disciplines. Level, team names, product names and
 * locations are dropped, so "Senior Backend Engineer", "Software Engineer, Backend (Cards)"
 * and "Staff Backend Software Engineer - NYC" at one company are one group.
 * "other" titles (no engineering family) keep their cleaned base title.
 */
export function groupKey(company, title) {
  const { family, disciplines } = roleShape(title);
  const co = String(company ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (family === "other") {
    const base = String(title ?? "").toLowerCase().split(/\s+[-–—|]\s+|,|:|\(/)[0].replace(LEVEL_WORDS_RE, " ").replace(CITY_RE, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    return `${co}|${base}`;
  }
  return `${co}|${[family, ...[...new Set(disciplines)].sort()].join(" ")}`;
}

// ---- HN "Who is hiring?" headers --------------------------------------------

const ROLE_WORD_RE = /\b(engineer|developer|architect|lead|swe|sde|programmer|scientist|designer|manager|founding)\b/i;

/**
 * "Acme / Senior Backend Engineer / REMOTE (US) / Full-time / $180K to $220K base"
 * -> { role, pay, contract }. Returns null when the title isn't a multi-part header.
 */
export function parseHnHeader(title, company = "") {
  const t = String(title ?? "");
  const parts = t.split(/\s+[|/]\s+|\s*\|\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const co = String(company ?? "").toLowerCase();
  const role = parts.find((x, i) => ROLE_WORD_RE.test(x) && !(i === 0 && co && x.toLowerCase().startsWith(co))) ?? parts[1];
  const contract = /\b(contract|contractor|freelance|part[- ]time|internship|intern)\b/i.test(t) && !/\bfull[- ]time\b/i.test(t);
  return { role: role.slice(0, 140), pay: parsePay(t), contract };
}

// ---- per-profile rules ----------------------------------------------------------
// A profile's config/ranking.yml carries `profile_rules` (see presets/*/config/ranking.yml):
//   location: { home: [words], secondary: [words] }       tier 1 = home metro, 3 = secondary
//   relevance: { title_family: [words], title_strong: [words], title_off: [words],
//                domains: { name: { weight, words: [...] } }, languages: [words] }
//   level: { stretch_words: [words] }   (rules / default are read by enrich via levelConfig)
const DEFAULT_RULES = { HOME, SECONDARY, TITLE_FAMILY_RE, TITLE_STRONG_RE, TITLE_OFF_RE, DOMAINS, LANGUAGES, STRETCH_DOMAIN_RE };
// A word list entry is a plain word or phrase (case-insensitive, spaces also match "-"), or
// "re:<regex source>" for a raw pattern (e.g. "re:payments?", "re:real[- ]?time").
const esc = (w) => {
  const t = String(w).trim();
  return t.startsWith("re:") ? `(?:${t.slice(3)})` : t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[- ]?");
};
export const wordsRe = (words, flags = "i") => {
  const list = [].concat(words ?? []).map(String).filter((w) => w.trim());
  return list.length ? new RegExp(`\\b(${list.map(esc).join("|")})\\b`, flags) : /(?!)/;
};

/** Apply (or, with null, reset) a profile's ranking rules. Returns the active rule set's keys. */
export function configureRankRules(rules) {
  ({ HOME, SECONDARY, TITLE_FAMILY_RE, TITLE_STRONG_RE, TITLE_OFF_RE, DOMAINS, LANGUAGES, STRETCH_DOMAIN_RE } = DEFAULT_RULES);
  if (!rules || typeof rules !== "object") return [];
  const set = [];
  if (rules.location?.home) { HOME = wordsRe(rules.location.home); set.push("location.home"); }
  if (rules.location?.secondary) { SECONDARY = wordsRe(rules.location.secondary); set.push("location.secondary"); }
  if (rules.level?.stretch_words) { STRETCH_DOMAIN_RE = wordsRe(rules.level.stretch_words); set.push("level.stretch_words"); }
  const r = rules.relevance ?? {};
  if (r.title_family) { TITLE_FAMILY_RE = wordsRe(r.title_family); set.push("title_family"); }
  if (r.title_strong) { TITLE_STRONG_RE = wordsRe(r.title_strong, "gi"); set.push("title_strong"); }
  if (r.title_off) { TITLE_OFF_RE = wordsRe(r.title_off); set.push("title_off"); }
  if (r.domains && typeof r.domains === "object") {
    DOMAINS = Object.freeze(Object.fromEntries(Object.entries(r.domains).map(([k, v]) => [k, { weight: Number(v?.weight) || 5, re: wordsRe(v?.words, "gi") }])));
    set.push("domains");
  }
  if (r.languages) { LANGUAGES = Object.freeze([].concat(r.languages).map((x) => String(x).toLowerCase())); set.push("languages"); }
  return set;
}
