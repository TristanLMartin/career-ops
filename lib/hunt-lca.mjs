// US Department of Labor H-1B LCA disclosure data -> per-company senior base salary
//. Pure functions; scripts/hunt-comp-refresh.mjs does the I/O.
//
// The DOL publishes quarterly xlsx files (one sheet, shared strings). We stream the sheet
// XML row by row and keep only the columns we need, so a 400 MB sheet never sits in memory.

export const WANTED_COLUMNS = ["CASE_STATUS", "EMPLOYER_NAME", "JOB_TITLE", "WORKSITE_CITY", "WORKSITE_STATE", "WAGE_RATE_OF_PAY_FROM", "WAGE_UNIT_OF_PAY"];

// Senior IC software titles: senior software / backend / full-stack / forward deployed /
// solutions engineer (or developer). "Senior Staff", "Staff", "Principal", managers and
// non-software engineers are out.
const SENIOR_RE = /\b(senior|sr\.?)\b/i;
const FAMILY_RE = /\b(software|back[- ]?end|full[- ]?stack|forward[- ]deployed|solutions?)\s+(engineer|developer)\b|\bforward[- ]deployed\b/i;
const OFF_RE = /\b(staff|principal|manager|director|head|vp|intern|test|qa|hardware|mechanical|electrical|data scien\w*)\b/i;

export function isSeniorSweTitle(title) {
  const t = String(title ?? "");
  return SENIOR_RE.test(t) && FAMILY_RE.test(t) && !OFF_RE.test(t);
}

// Many large employers file every level under one generic title (Meta "Software Engineer",
// Anthropic "Member of Technical Staff", Microsoft "Software Engineering"). Those rows mix
// levels, so their p75 stands in for a senior base when a company has too few "Senior" rows.
const GENERIC_RE = /^\s*(software (engineer|developer|engineering)|member of (the )?technical staff)(\s*[(,-]\s*(software|back[- ]?end|full[- ]?stack|engineering|software engineering)[^)]*\)?)?\s*$/i;
export function isGenericSweTitle(title) {
  return GENERIC_RE.test(String(title ?? ""));
}

const UNIT = { year: 1, hour: 2080, week: 52, "bi-weekly": 26, biweekly: 26, month: 12 };

/** Annual USD from a wage and its unit (Year, Hour, Week, Bi-Weekly, Month); null if unusable. */
export function annualize(wage, unit) {
  const n = Number(String(wage ?? "").replace(/[$,\s]/g, ""));
  const f = UNIT[String(unit ?? "").trim().toLowerCase()];
  if (!Number.isFinite(n) || n <= 0 || !f) return null;
  const v = n * f;
  return v >= 30000 && v <= 2000000 ? Math.round(v) : null;
}

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

/**
 * Home-metro split (lca-employers.yml `home: { states: [WA], cities: [Seattle, Bellevue] }`).
 * Without one, every summary is national.
 */
export function normalizeHome(home) {
  const up = (v) => [].concat(v ?? []).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
  const states = up(home?.states ?? home?.state);
  const cities = new Set(up(home?.cities));
  return states.length || cities.size ? { states, cities } : null;
}

/** Normalized employer key for the match table ("STRIPE, INC." -> "stripe inc"). */
export function normEmployer(s) {
  return String(s ?? "").toUpperCase().replace(/[.,'’"]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * employers: { "Stripe": ["STRIPE, INC.", ...] } -> Map<normalized employer name, company>.
 */
export function employerIndex(employers) {
  const m = new Map();
  for (const [company, names] of Object.entries(employers ?? {})) {
    for (const n of Array.isArray(names) ? names : [names]) if (n) m.set(normEmployer(n), company);
  }
  return m;
}

/** One LCA row (object keyed by column name) -> { company, wage, home, tier } or null. */
export function filterRow(row, index, home = null) {
  const h = home && home.cities instanceof Set ? home : normalizeHome(home);
  if (!/^certified$/i.test(String(row.CASE_STATUS ?? "").trim())) return null;
  const company = index.get(normEmployer(row.EMPLOYER_NAME));
  if (!company) return null;
  const tier = isSeniorSweTitle(row.JOB_TITLE) ? "senior" : isGenericSweTitle(row.JOB_TITLE) ? "generic" : null;
  if (!tier) return null;
  const wage = annualize(row.WAGE_RATE_OF_PAY_FROM, row.WAGE_UNIT_OF_PAY);
  if (wage == null) return null;
  const state = String(row.WORKSITE_STATE ?? "").trim().toUpperCase();
  const city = String(row.WORKSITE_CITY ?? "").trim().toUpperCase();
  const inHome = !!h && (!h.states.length || h.states.includes(state)) && (!h.cities.size || h.cities.has(city));
  return { company, wage, home: inHome, tier };
}

/**
 * Rows from filterRow -> { company: { basis, n, median, p25, p75, home } }.
 * Uses "Senior" titles when a company has >= minSenior of them; otherwise generic-title rows
 * (all levels) with their p75 as the senior proxy, when there are >= minGeneric. The home-metro
 * split needs n >= minHome.
 */
export function summarize(rows, { minHome = 5, minSenior = 3, minGeneric = 5 } = {}) {
  const by = new Map();
  for (const r of rows) {
    if (!r) continue;
    if (!by.has(r.company)) by.set(r.company, { senior: [], generic: [] });
    by.get(r.company)[r.tier === "generic" ? "generic" : "senior"].push(r);
  }
  const stats = (a) => { const s = a.map((r) => r.wage).sort((x, y) => x - y); return { n: s.length, median: quantile(s, 0.5), p25: quantile(s, 0.25), p75: quantile(s, 0.75) }; };
  const out = {};
  for (const [company, g] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
    let rowsUsed, basis;
    if (g.senior.length >= minSenior) { rowsUsed = g.senior; basis = "senior titles"; }
    else if (g.generic.length >= minGeneric) { rowsUsed = g.generic; basis = "generic titles, p75 as senior proxy"; }
    else continue;
    const proxy = basis.startsWith("generic");
    const pick = (st) => (proxy ? { n: st.n, median: st.p75, p25: null, p75: null, allLevels: { median: st.median, p25: st.p25, p75: st.p75 } } : st);
    const local = rowsUsed.filter((r) => r.home);
    out[company] = { basis, ...pick(stats(rowsUsed)), home: local.length >= minHome ? pick(stats(local)) : null };
  }
  return out;
}

/**
 * Est. TC = LCA senior base median (home metro when n >= 5, else national) x the curated
 * company's TC / base ratio. Null when either side is missing.
 */
export function estimateFromLca(summary, curated) {
  if (!summary || !curated?.tc_median_usd || !curated?.base_usd) return null;
  const local = summary.home ?? summary.seattle ?? null; // `seattle`: summaries written by older versions
  const base = local?.median ?? summary.median;
  if (!base) return null;
  const ratio = curated.tc_median_usd / curated.base_usd;
  return { lcaBase: base, n: local ? local.n : summary.n, basis: local ? "home area" : "US", ratio: Math.round(ratio * 100) / 100, tc: Math.round((base * ratio) / 1000) * 1000, label: "est. TC (DOL base × curated ratio)" };
}

// ---- xlsx sheet streaming ----------------------------------------------------------

const XML_ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function unxml(s) {
  return String(s).replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, e) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : XML_ENT[e.toLowerCase()]));
}

/** sharedStrings.xml text -> array of strings (rich-text runs joined). */
export function parseSharedStrings(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let s = "";
    for (const t of m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += t[1];
    out.push(unxml(s));
  }
  return out;
}

function colIndex(ref) {
  const letters = ref.replace(/\d+$/, "");
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** One <row>...</row> -> sparse array of cell values (shared strings resolved). */
export function parseRowXml(rowXml, shared) {
  const cells = [];
  for (const m of rowXml.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, ref, attrs, inner = ""] = m;
    const t = attrs.match(/\st="([^"]+)"/)?.[1];
    let v;
    if (t === "inlineStr") v = unxml((inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/) ?? [])[1] ?? "");
    else {
      const raw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      if (raw == null) continue;
      v = t === "s" ? shared[Number(raw)] : unxml(raw);
    }
    cells[colIndex(ref)] = v;
  }
  return cells;
}

/**
 * Async-iterates a sheet XML stream (string chunks) and yields row objects keyed by the
 * header row, limited to `wanted` columns.
 */
export async function* sheetRows(chunks, shared, wanted = WANTED_COLUMNS) {
  let buf = "";
  let header = null;
  for await (const chunk of chunks) {
    buf += chunk;
    let end;
    while ((end = buf.indexOf("</row>")) !== -1) {
      const start = buf.lastIndexOf("<row", end);
      const rowXml = buf.slice(start, end);
      buf = buf.slice(end + 6);
      const cells = parseRowXml(rowXml, shared);
      if (!header) {
        header = new Map();
        cells.forEach((name, i) => { if (wanted.includes(String(name).trim())) header.set(i, String(name).trim()); });
        const missing = wanted.filter((w) => ![...header.values()].includes(w));
        if (missing.length) throw new Error(`LCA sheet is missing columns: ${missing.join(", ")}`);
        continue;
      }
      const row = {};
      for (const [i, name] of header) row[name] = cells[i];
      yield row;
    }
  }
}
