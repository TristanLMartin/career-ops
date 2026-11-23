#!/usr/bin/env node
// hunt-enrich: zero-token enrichment of every inbox posting and tracker row.
//
// Writes data/hunt-enrich.json, keyed by posting URL:
//   pay (parsed from the stored comp, or from the job description), location tier,
//   benefit flags (regex over the JD), relevance (keywords vs profile + cv.md),
//   fit (the career-ops evaluation score when a report exists) and a weighted
//   composite (weights in config/ranking.yml).
//
// Job descriptions come from the public board APIs that expose them in one call
// per company (Greenhouse ?content=true, Ashby posting API, Lever postings API),
// cached under data/cache/hunt-jd/ for 20 hours, one request per second.
// JD text is untrusted data: it is only matched against fixed regexes here.
//
// Usage: node scripts/hunt-enrich.mjs [--no-fetch] [--quiet]
import fs from "node:fs";
import path from "node:path";
import { loadYaml } from "../lib/yaml-document.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { getCareerOpsRoot, resolveTrackerPath, getProfilePath } from "../path-resolver.mjs";
import { parseTrackerRow, resolveColumns } from "../tracker-parse.mjs";
import {
  DEFAULT_WEIGHTS, DEFAULT_PAY_BAND, LOCATION_TIER_SCORE,
  locationTier, parsePay, payScore, benefitFlags, benefitScore,
  relevanceTargets, relevanceScore, parseFit, fitToPct, composite, levelFit, DEFAULT_BIG_COMPANIES,
  payFromDescription, relevanceV2, relevanceDomains, groupKey, parseHnHeader, companyBoost, boostedComposite, configureRankRules, hasRelevanceRules, normalizeTarget, onTarget, levelOnTarget, placeOnTarget, shortlistLevelOk,
} from "../lib/hunt-rank.mjs";
import { readPerson } from "../lib/profile-paths.mjs";
import { updateFirstSeen } from "../lib/hunt-first-seen.mjs";
import { loadCompDoc, compFor, confidenceAtLeast, tcScore, companyScore, normCompany, DEFAULT_TC_BAND } from "../lib/hunt-comp.mjs";
import { loadLevelsDoc, bestTcEstimate } from "../lib/hunt-levels.mjs";
import { employmentType } from "../lib/hunt-employment.mjs";
import { exitOnHelp } from "../lib/cli-guard.mjs";

const args = new Set(process.argv.slice(2));
const NO_FETCH = args.has("--no-fetch");
const QUIET = args.has("--quiet");
const log = (...a) => { if (!QUIET) console.log(...a); };

const root = getCareerOpsRoot();
const CACHE_DIR = path.join(root, "data", "cache", "hunt-jd");
const CACHE_TTL_MS = 20 * 3600 * 1000;
const OUT = path.join(root, "data", "hunt-enrich.json");
const UA = "career-ops-enrich/1.0 (personal job search; low volume)";

function readText(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

/** A group copy inherits its leader's fit only at the same level and location tier. */
export function sameLevelAndPlace(e, lead) {
  return (e?.level?.key ?? "senior") === (lead?.level?.key ?? "senior") && (e?.locationTier ?? null) === (lead?.locationTier ?? null);
}

/**
 * Sort comparator for a duplicate group's urls, leader first: one at a usable level and place;
 * then the best own fit score (unscored last); then the most complete JD (not thin), with posted
 * pay; then composite; then JD length.
 */
export function groupLeaderOrder(out, target = null) {
  const t = normalizeTarget(target);
  const usable = (e) => onTarget(e, t) && !e.belowFloor;
  const fitOf = (e) => (typeof e.fit === "number" ? e.fit : -1);
  return (a, b) => usable(out[b]) - usable(out[a]) || fitOf(out[b]) - fitOf(out[a]) || !out[b].relevanceEst - !out[a].relevanceEst || (out[b].pay != null) - (out[a].pay != null) || (out[b].composite ?? -1) - (out[a].composite ?? -1) || (out[b].jdChars ?? 0) - (out[a].jdChars ?? 0);
}

export function loadRankingConfig(rootDir = root) {
  const file = path.join(rootDir, "config", "ranking.yml");
  let cfg = {};
  try { cfg = loadYaml(readText(file)) ?? {}; } catch (e) { console.warn(`ranking.yml unreadable, using defaults: ${e.message}`); }
  const weights = { ...DEFAULT_WEIGHTS, ...(cfg.weights ?? {}) };
  const band = { ...DEFAULT_PAY_BAND, ...(cfg.pay_band ?? {}) };
  // Level: profile_rules.level.rules (a ladder for any field) when present, else the built-in IC
  // ladder; level.no_title_levels: companies whose plain titles carry no level (read as target).
  const pl = cfg.profile_rules?.level ?? {};
  const level = { bigCompanies: cfg.level?.big_companies ?? [...DEFAULT_BIG_COMPANIES], factors: cfg.level?.factors ?? {}, noTitleLevels: cfg.level?.no_title_levels ?? [], rules: Array.isArray(pl.rules) || pl.default ? (pl.rules ?? []) : undefined, defaultLevel: pl.default };
  const tcBand = { ...DEFAULT_TC_BAND, ...(cfg.tc_band ?? {}) };
  // pay_basis: base (default) scores the posting's base midpoint; tc scores tc_est when its
  // confidence is medium or high, falling back to the base midpoint.
  const payBasis = cfg.pay_basis === "tc" ? "tc" : "base";
  // location_scores overrides LOCATION_TIER_SCORE per tier (1 home, 2 remote US, 3 secondary, 4 other, 5 global).
  const locationScores = Object.fromEntries(Object.entries(cfg.location_scores ?? {}).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [Number(k), Number(v)]));
  const unverified = new Set((cfg.unverified_companies ?? []).map((c) => String(c).trim().toLowerCase()));
  const aliases = Object.entries(cfg.company_aliases ?? {}).flatMap(([re, name]) => { try { return [[new RegExp(re, "i"), String(name)]]; } catch { return []; } });
  const researchTier = new Map();
  for (const [factor, names] of Object.entries(cfg.research_tier ?? {})) for (const n of names ?? []) researchTier.set(normCompany(n), Number(factor));
  const caution = new Set((cfg.caution_companies ?? []).map((c) => normCompany(c)));
  const locationLabels = Object.fromEntries(Object.entries(cfg.location_labels ?? {}).map(([k, v]) => [Number(k), String(v)]));
  return { levelsHome: typeof cfg.levels?.home_location === "string" && cfg.levels.home_location.trim() ? cfg.levels.home_location.trim() : null, tcHome: { factor: Number(cfg.tc_home?.factor) > 0 ? Number(cfg.tc_home.factor) : 1, basis_words: [].concat(cfg.tc_home?.basis_words ?? []) }, mapFamiliesCfg: cfg.map_families ?? null, target: normalizeTarget(cfg.target), locationLabels, currency: String(cfg.currency ?? "USD"), profileRules: cfg.profile_rules ?? null, aliases, researchTier, caution, weights, band, level, shortlist: cfg.shortlist ?? null, companyBoost: cfg.company_boost ?? {}, tcBand, payBasis, locationScores, unverified, payMissing: Number.isFinite(Number(cfg.pay_missing_score)) && cfg.pay_missing_score != null ? Number(cfg.pay_missing_score) : null, baseFloor: Number(cfg.base_floor) > 0 ? Number(cfg.base_floor) : null, excludeContract: cfg.exclude_contract === true, excludeBelowFloor: cfg.exclude_below_floor === true };
}

const LEVEL_WORDS = new Set(["senior", "sr", "junior", "jr", "lead", "staff", "principal", "head", "manager", "director", "i", "ii", "iii", "associate", "the", "and", "of", "for"]);
/**
 * Map role categories: ranking.yml map_families ({ Name: [words] }), else up to 4 of the
 * profile's target_roles (level words dropped, so "Senior Technical Recruiter" matches any
 * "technical recruiter"); null = the Map's built-in software categories.
 */
export function mapFamilies(cfg, person = {}) {
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
    const out = Object.entries(cfg).map(([name, words]) => ({ name, words: [].concat(words ?? []).map(String) })).filter((f) => f.words.length);
    if (out.length) return out.slice(0, 4);
  }
  const seen = new Set();
  const out = [];
  for (const role of [].concat(person.target_roles ?? [])) {
    const core = String(role).split(/\s+/).filter((w) => !LEVEL_WORDS.has(w.toLowerCase().replace(/\.$/, ""))).join(" ").trim();
    if (!core || seen.has(core.toLowerCase())) continue;
    seen.add(core.toLowerCase());
    out.push({ name: core, words: [core] });
    if (out.length === 4) break;
  }
  return out.length ? out : null;
}

/** The company's DOL LCA summary row, trimmed for the UI. */
function lcaFor(lca, company, compEntry) {
  const v = lca.get(normCompany(company)) ?? (compEntry ? lca.get(normCompany(compEntry.company)) : null);
  if (!v) return undefined;
  const local = v.home ?? v.seattle ?? null; // `seattle`: summaries from older versions
  return { base: local?.median ?? v.median, n: local?.n ?? v.n, where: local ? "home area" : "US", basis: v.basis, estTc: v.est?.tc ?? null, ratio: v.est?.ratio ?? null };
}

/** A posted USD base (not OTE) whose annual max is below the floor. Straddling or unknown: false. */
/** Canonical company name through config company_aliases. */
export function canonicalCompany(name, aliases = []) {
  const n = String(name ?? "").trim();
  for (const [re, to] of aliases) if (re.test(n)) return to;
  return n;
}

export function isBelowFloor(pay, floor) {
  if (!floor || !pay || pay.basis === "OTE" || pay.currency !== "USD" || !Number.isFinite(pay.annualMax)) return false;
  return pay.annualMax < floor;
}

/** config/comp.json (per-company senior TC research), or an empty map. */
export function loadComp(rootDir = root) {
  const tcHome = loadRankingConfig(rootDir).tcHome;
  try { return loadCompDoc(JSON.parse(readText(path.join(rootDir, "config", "comp.json"))), { homeWords: tcHome.basis_words }); } catch { return new Map(); }
}

export function parsePipeline(text) {
  const rows = [];
  let inPending = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) { inPending = line.trim().toLowerCase() === "## pending"; continue; }
    if (!inPending || !/^- \[[ x!]\] /.test(line)) continue;
    const parts = line.slice(6).split(" | ").map((s) => s.trim());
    const labeled = {};
    const positional = [];
    for (const p of parts) {
      const m = p.match(/^(posted|trust|yrs|note|closes):\s*(.*)$/);
      if (m) labeled[m[1]] = m[2]; else positional.push(p);
    }
    const [url, company = "", role = "", location = "", comp = ""] = positional;
    if (!/^https?:\/\//.test(url ?? "")) continue;
    rows.push({ url, company, role, location, comp, posted: labeled.posted ?? "", source: "inbox" });
  }
  return rows;
}

function readTracker() {
  const file = resolveTrackerPath(root);
  const lines = readText(file).split("\n");
  const colmap = resolveColumns(lines);
  return lines.map((l) => parseTrackerRow(l, colmap)).filter(Boolean);
}

// ---- evaluation reports (why / biggest gap, no AI) ----------------------------

/** From a career-ops report: decision, one-line why and the single biggest gap. */
export function reportSummary(md) {
  const text = String(md ?? "");
  const lead = text.match(/^## Verdict \(lead\)\s*\n+([\s\S]*?)(?:\n---|\n## )/m)?.[1]?.trim() ?? "";
  const ms = text.match(/## Machine Summary\s*\n+```ya?ml\n([\s\S]*?)\n```/)?.[1];
  let y = {};
  try { y = (ms && loadYaml(ms)) || {}; } catch { y = {}; }
  const first = (v) => (Array.isArray(v) && v.length ? String(v[0]) : "");
  const decision = String(y.final_decision ?? lead.match(/^\*\*([^*]+?)\.?\*\*/)?.[1] ?? "").trim();
  // Lead paragraph minus its bold decision word, first sentence only.
  const leadText = lead.replace(/^\*\*[^*]+\*\*\s*/, "").replace(/\s+/g, " ");
  const why = (leadText.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? leadText).slice(0, 220) || first(y.top_strengths);
  const gap = first(y.hard_stops) || first(y.soft_gaps) || "";
  return { decision, why, gap: gap.slice(0, 200), strength: first(y.top_strengths).slice(0, 200), nextAction: String(y.next_action ?? "").slice(0, 220), advertisedComp: y.advertised_comp ?? null, level: levelAssessment(text, decision) };
}

/**
 * hunt: does the report say the candidate meets a Staff+ posting's level? No AI, read from the
 * report text. Below the bar: a level/Staff/title requirement row marked ❌ Missing, or the words
 * "level mismatch" / "level-mismatch". Meets: otherwise, when the verdict is Apply (not Consider).
 * `why` quotes the report's own sentence. Null when the report says nothing about a Staff level.
 */
export function levelAssessment(md, decision = "") {
  const text = String(md ?? "");
  const section = text.match(/^## C\)[^\n]*\n([\s\S]*?)(?=\n## )/m)?.[1] ?? "";
  if (!/\b(staff|principal|level)\b/i.test(section + text.slice(0, 3000))) return null;
  const clean = (s) => String(s).replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  const sentences = (s) => String(s).replace(/^\s*(\d+\.|-|\*)\s+/gm, " ").replace(/\*\*|`/g, "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z])/).filter((x) => x.length > 12);
  const missRow = text.split("\n").find((l) => /^\|/.test(l) && /❌/.test(l) && /\b(staff\+?|principal|level|title)\b/i.test(String(l.split("|")[1] ?? "").replace(/\bC-level\b/gi, "")));
  const mismatch = sentences(text).find((x) => /level[- ]mismatch/i.test(x));
  if (missRow) {
    const cells = missRow.split("|").map((c) => c.trim()).filter(Boolean);
    return { meets: false, why: clean(`${cells[0]}: missing. ${cells[cells.length - 1] ?? ""}`) };
  }
  if (mismatch) return { meets: false, why: clean(mismatch) };
  const said = sentences(section).find((x) => /stretch|above|one (band|level)/i.test(x)) ?? sentences(section)[0] ?? "";
  return /^(strong )?apply/i.test(String(decision)) ? { meets: true, why: clean(said) } : { meets: false, why: clean(said || `Verdict ${decision}`) };
}

function reportFileFromCell(cell) {
  const m = String(cell ?? "").match(/\]\(([^)]+\.md)\)/);
  if (!m) return null;
  const name = path.basename(m[1]);
  const file = path.join(root, "reports", name);
  return fs.existsSync(file) ? { name, file, n: name.match(/^(\d+)/)?.[1] ?? null } : null;
}

// ---- provider boards (one request per company) -----------------------------

function boardFor(entry) {
  const api = entry.api ?? "";
  const url = entry.careers_url ?? "";
  let m = api.match(/boards-api\.greenhouse\.io\/v1\/boards\/([^/?#]+)/) || url.match(/greenhouse\.io\/(?:embed\/job_board\?for=)?([^/?#]+)/);
  if (m) return { provider: "greenhouse", token: m[1] };
  m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (m) return { provider: "ashby", token: m[1] };
  m = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (m) return { provider: "lever", token: m[1] };
  m = url.match(/ats\.rippling\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)\/jobs/);
  if (m) return { provider: "rippling", token: m[1] };
  return null;
}

// A JD shorter than this is "thin": relevance is then a title-only estimate (relevanceEst).
export const THIN_JD_CHARS = 600;
const POSTING_FETCH_CAP = 80; // per-posting API calls per run (Rippling detail endpoint)

// Rippling boards run to hundreds of postings, so fetch only the postings we need,
// one public detail call each, cached by uuid (same TTL as the board caches).
async function ripplingPostings(token, ids, budget) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `rippling-${token.replace(/[^a-z0-9_-]/gi, "_")}.json`);
  let cache = {};
  try { cache = JSON.parse(readText(file)).postings ?? {}; } catch {}
  const texts = {};
  let fetched = 0, errors = 0;
  for (const id of ids) {
    const c = cache[id];
    const fresh = c && (NO_FETCH || Date.now() - c.fetchedAt < CACHE_TTL_MS);
    if (!fresh && !NO_FETCH && budget.left > 0) {
      budget.left--;
      try {
        const d = await politeFetchJson(`https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(token)}/jobs/${encodeURIComponent(id)}`);
        const pay = (d.payRangeDetails ?? []).map((p) => `Pay range ${p.location ?? ""}: ${p.currency === "USD" ? "$" : `${p.currency} `}${Number(p.rangeStart).toLocaleString("en-US")} - ${p.currency === "USD" ? "$" : ""}${Number(p.rangeEnd).toLocaleString("en-US")} per ${String(p.frequency ?? "year").toLowerCase()}`);
        cache[id] = { fetchedAt: Date.now(), text: [htmlToText(d.description?.role), htmlToText(d.description?.company), ...pay].filter(Boolean).join("\n") };
        fetched++;
      } catch (e) {
        errors++;
        if (!c) cache[id] = { fetchedAt: Date.now(), text: "", error: e.message };
      }
    }
    if (cache[id]?.text) texts[id] = cache[id].text;
  }
  if (fetched || errors) fs.writeFileSync(file, JSON.stringify({ postings: cache }));
  return { texts, from: `${fetched} fetched, ${errors} errors, ${Object.keys(texts).length} with text` };
}

export function jobIdFromUrl(url, provider) {
  if (provider === "greenhouse") {
    const m = url.match(/[?&]gh_jid=(\d+)/) || url.match(/\/jobs\/(\d+)/);
    return m ? m[1] : null;
  }
  const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0].toLowerCase() : null;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", middot: "·" };
export function htmlToText(html) {
  let s = String(html ?? "");
  for (let i = 0; i < 2; i++) s = s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : all; }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
  return s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|li|div|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

let lastFetch = 0;
async function politeFetchJson(url) {
  const wait = lastFetch + 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetch = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchBoard({ provider, token }) {
  if (provider === "greenhouse") {
    const data = await politeFetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`);
    return Object.fromEntries((data.jobs ?? []).map((j) => [String(j.id), htmlToText(j.content)]));
  }
  if (provider === "ashby") {
    const data = await politeFetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`);
    return Object.fromEntries((data.jobs ?? []).map((j) => [String(j.id).toLowerCase(), [j.descriptionPlain ?? htmlToText(j.descriptionHtml), j.compensation?.compensationTierSummary ?? ""].join("\n")]));
  }
  if (provider === "lever") {
    const data = await politeFetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`);
    return Object.fromEntries((Array.isArray(data) ? data : []).map((j) => [String(j.id).toLowerCase(), [j.descriptionPlain, ...(j.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`), j.additionalPlain, j.salaryDescriptionPlain].filter(Boolean).join("\n")]));
  }
  return {};
}

async function boardTexts(board) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${board.provider}-${board.token.replace(/[^a-z0-9_-]/gi, "_")}.json`);
  let cached = null;
  try { cached = JSON.parse(readText(file)); } catch {}
  if (cached && (NO_FETCH || Date.now() - cached.fetchedAt < CACHE_TTL_MS)) return { texts: cached.texts ?? {}, from: "cache" };
  if (NO_FETCH) return { texts: {}, from: "none" };
  try {
    const texts = await fetchBoard(board);
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), texts }));
    return { texts, from: "network" };
  } catch (e) {
    if (cached) return { texts: cached.texts ?? {}, from: `stale cache (${e.message})` };
    return { texts: {}, from: `error: ${e.message}`, error: e.message };
  }
}

// ---- main --------------------------------------------------------------------

export async function enrich() {
  const { levelsHome, tcHome: { factor: tcHomeFactor }, mapFamiliesCfg, target, locationLabels, currency, profileRules, aliases, researchTier, caution, weights, band, level: levelCfg, shortlist: rankingShortlist, companyBoost: boosts, tcBand, payBasis, locationScores, unverified, payMissing, baseFloor, excludeContract, excludeBelowFloor } = loadRankingConfig();
  // The profile's own rules (location tiers, relevance words, stretch domains).
  configureRankRules(profileRules);
  // No relevance words configured: relevance is the target-roles + CV-skills score instead.
  const useV2 = hasRelevanceRules();
  // TC estimates from tech-company comp data and the DOL LCA table apply only to a tech profile
  // (config/person.yml is_tech); otherwise the pay part uses posted ranges only.
  const techComp = readPerson(root).is_tech === true;
  const compMap = loadComp();
  // Levels.fyi per-level TC (scripts/hunt-levels-refresh.mjs); wins over the research table.
  let levelsMap = new Map();
  try { levelsMap = loadLevelsDoc(JSON.parse(readText(path.join(root, "data", "comp-levels.json")))); } catch { /* not fetched yet */ }
  // DOL H-1B LCA senior base per company (scripts/hunt-comp-refresh.mjs); display only.
  let lca = new Map();
  try { lca = new Map(Object.entries(JSON.parse(readText(path.join(root, "data", "comp-lca-summary.json"))).companies ?? {}).map(([c, v]) => [normCompany(c), v])); } catch { /* not built yet */ }
  let profile = {};
  try { profile = loadYaml(readText(getProfilePath(root))) ?? {}; } catch {}
  const targets = relevanceTargets(profile, readText(path.join(root, "cv.md")));
  // Best overall's half-tier boost (web/src/lib/hunt-rank-order.mjs tierUnits): the profile's
  // favorite and stretch companies (config/profile.yml narrative.preferences).
  const prefs = profile?.narrative?.preferences ?? {};
  const rankBoostCos = new Set([...(prefs.favorite_companies ?? []), ...(prefs.stretch_companies ?? [])].map((c) => normCompany(canonicalCompany(String(c), aliases))));

  const inbox = parsePipeline(readText(path.join(root, "data", "pipeline.md"))).map((r) => ({ ...r, rawCompany: r.company, company: canonicalCompany(r.company, aliases) }));
  const tracker = readTracker();
  // hunt: the fit before a re-evaluation on another model (scripts/hunt-reeval.mjs).
  let prevFits = {};
  try { prevFits = JSON.parse(readText(path.join(root, "data", "hunt-prev-fit.json")) || "{}"); } catch {}
  const fitByUrl = new Map();
  const statusByUrl = new Map();
  const reportByUrl = new Map();
  for (const t of tracker) {
    if (!t.url) continue;
    const f = parseFit(t.score);
    if (f != null) fitByUrl.set(t.url, f);
    statusByUrl.set(t.url, t.status);
    const rf = reportFileFromCell(t.report);
    if (rf) reportByUrl.set(t.url, { n: rf.n, tracker: String(t.num), ...reportSummary(readText(rf.file)) });
  }
  const all = [...inbox];
  const seen = new Set(inbox.map((r) => r.url));
  for (const t of tracker) {
    if (!t.url || seen.has(t.url)) continue;
    // hunt: the posting date the scan wrote into the tracker notes ("posted: 2024-06-14").
    const posted = String(t.notes ?? "").match(/posted:\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
    all.push({ url: t.url, company: t.company, role: t.role, location: t.location ?? "", comp: "", posted, source: "tracker" });
  }

  let portals = {};
  try { portals = loadYaml(readText(path.join(root, "portals.yml"))) ?? {}; } catch {}
  const boards = new Map();
  for (const entry of portals.tracked_companies ?? []) {
    const b = boardFor(entry);
    if (b && entry.name) boards.set(entry.name.toLowerCase(), b);
  }

  // Boards found by scripts/hunt-discover.mjs (HN / manual adds) are read the same way.
  try {
    for (const b of JSON.parse(readText(path.join(root, "data", "hunt-discovery.json"))).boards ?? []) {
      const nb = boardFor({ careers_url: b.careers_url });
      if (nb && b.name && !boards.has(String(b.name).toLowerCase())) boards.set(String(b.name).toLowerCase(), nb);
    }
  } catch { /* no discovery yet */ }
  // Boards mined from VC portfolio pages (scripts/hunt-discover-wide.mjs vc), scanned daily.
  const vcBoardNames = new Map();
  try {
    const vc = JSON.parse(readText(path.join(root, "data", "discovery-vc.yml")).replace(/^#.*\n/, ""));
    for (const e of vc.tracked_companies ?? []) {
      const nb = boardFor(e);
      if (e.name) vcBoardNames.set(String(e.name).toLowerCase(), String(e.notes ?? "").match(/^discovery:(\S+)/)?.[1] ?? "vc-portfolio");
      if (nb && e.name && !boards.has(String(e.name).toLowerCase())) boards.set(String(e.name).toLowerCase(), nb);
    }
  } catch { /* no VC discovery yet */ }
  // Named target companies (scripts/hunt-discover-wide.mjs targets).
  const targetNames = new Set();
  try {
    const tg = JSON.parse(readText(path.join(root, "data", "discovery-targets.yml")).replace(/^#.*\n/, ""));
    for (const e of tg.tracked_companies ?? []) {
      if (!e.name) continue;
      targetNames.add(String(e.name).toLowerCase());
      const nb = boardFor(e);
      if (nb && !boards.has(String(e.name).toLowerCase())) boards.set(String(e.name).toLowerCase(), nb);
    }
  } catch { /* no targets yet */ }
  const discoverySourceByName = new Map();
  try {
    for (const b of JSON.parse(readText(path.join(root, "data", "hunt-discovery.json"))).boards ?? []) if (b.name && b.source) discoverySourceByName.set(String(b.name).toLowerCase(), String(b.source));
  } catch { /* none */ }
  // A posting whose company has no known board (Built In / Getro / Dice / recruiter finds)
  // still gets its JD when the posting URL itself is on a known ATS.
  const boardOf = (r) => {
    const own = boardFor({ careers_url: r.url });
    const b = boards.get(r.company.toLowerCase());
    return b && jobIdFromUrl(r.url, b.provider) && (!own || own.provider === b.provider) ? b : own;
  };
  const needed = new Map();
  const ripplingIds = new Map();
  for (const r of all) {
    const b = boardOf(r);
    if (!b) continue;
    if (b.provider === "rippling") {
      const id = jobIdFromUrl(r.url, "rippling");
      if (id) { if (!ripplingIds.has(b.token)) ripplingIds.set(b.token, new Set()); ripplingIds.get(b.token).add(id); }
      continue;
    }
    needed.set(`${b.provider}:${b.token}`, b);
  }
  const texts = new Map();
  const fetchLog = [];
  for (const [key, b] of needed) {
    const res = await boardTexts(b);
    texts.set(key, res.texts);
    fetchLog.push({ board: key, jobs: Object.keys(res.texts).length, from: res.from });
  }
  const budget = { left: POSTING_FETCH_CAP };
  for (const [token, ids] of ripplingIds) {
    const res = await ripplingPostings(token, [...ids], budget);
    texts.set(`rippling:${token}`, res.texts);
    fetchLog.push({ board: `rippling:${token}`, jobs: Object.keys(res.texts).length, from: res.from });
  }

  // Where each posting came from: the portals.yml watchlist, discovery (HN / discovered
  // boards, scripts/hunt-discover.mjs) or added by hand (scan-history portal "manual").
  const watchedNames = new Set((portals.tracked_companies ?? []).map((e) => String(e.name ?? "").toLowerCase()));
  const portalByUrl = new Map();
  {
    const hist = readText(path.join(root, "data", "scan-history.tsv")).split("\n");
    const hh = (hist[0] ?? "").split("\t");
    const ui = hh.indexOf("url"), pi = hh.indexOf("portal");
    for (const line of hist.slice(1)) { const c = line.split("\t"); if (c[ui]) portalByUrl.set(c[ui], c[pi] ?? ""); }
  }
  const originOf = (r) => {
    const portal = portalByUrl.get(r.url) ?? "";
    if (portal === "manual") return "manual";
    if (/hackernews|^discovery/i.test(portal) || !watchedNames.has(String(r.company).toLowerCase())) return "discovery";
    return "watchlist";
  };
  // Sub-source of a discovery posting: which channel found it.
  const channelOf = (r, origin) => {
    if (origin !== "discovery") return undefined;
    const portal = portalByUrl.get(r.url) ?? "";
    if (/^discovery-/.test(portal)) return portal.slice("discovery-".length);
    if (/^hackernews/.test(portal)) return "hn";
    if (/^getro/.test(portal)) return "vc-getro";
    if (/^a16z-speedrun/.test(portal)) return "vc-a16z-speedrun";
    if (/^builtin/.test(portal)) return "builtin";
    if (targetNames.has(String(r.company).toLowerCase()) || targetNames.has(String(r.rawCompany ?? "").toLowerCase())) return "target";
    const src = discoverySourceByName.get(String(r.company).toLowerCase());
    if (src) return /^hn:/.test(src) ? "hn" : src;
    if (vcBoardNames.has(String(r.company).toLowerCase())) return vcBoardNames.get(String(r.company).toLowerCase());
    return "other";
  };
  let manualJd = {};
  try { manualJd = JSON.parse(readText(path.join(CACHE_DIR, "manual.json"))).texts ?? {}; } catch {}
  // Per-posting JDs for big-tech careers sites (scripts/hunt-jd-fetch.mjs).
  try { for (const [u, v] of Object.entries(JSON.parse(readText(path.join(CACHE_DIR, "sites.json"))).postings ?? {})) if (v?.text && !manualJd[u]) manualJd[u] = v.text; } catch {}
  const out = {};
  const snippets = {}; // first 1,500 JD characters per URL, for scripts/hunt-quickscore.mjs
  let withDesc = 0;
  for (const r of all) {
    const b = boardOf(r);
    const id = b ? jobIdFromUrl(r.url, b.provider) : null;
    // Decode again on read: older cache files kept entities like &mdash; as text.
    // Jobs added by hand (scripts/hunt-add-job.mjs) keep their JD in manual.json, keyed by URL.
    const desc = htmlToText((b && id ? texts.get(`${b.provider}:${b.token}`)?.[id] : null) ?? manualJd[r.url] ?? "");
    if (desc) { withDesc++; snippets[r.url] = desc.slice(0, 1500); }
    let location = r.location;
    if (!location && r.source === "tracker") {
      const inboxRow = inbox.find((i) => i.url === r.url);
      location = inboxRow?.location ?? "";
    }
    // The JD's band for a high-cost US location (or the highest US band) beats the scanner's
    // stored comp, which is often the first (lowest) zone. Base salary only.
    // HN "Who is hiring?" rows carry the whole post header as the title.
    const hn = parseHnHeader(r.role, r.company);
    const roleForScoring = hn?.role ?? r.role;
    const jdPay = payFromDescription(desc) ?? (hn?.pay && hn.pay.period === "year" ? { ...hn.pay, basis: "base", band: "HN post" } : null);
    const storedPay = parsePay(r.comp);
    const textPay = !jdPay && !storedPay ? parsePay(desc) : null; // e.g. Dice "USD 175,000.00 - 215,000.00 per year"
    const pay = jdPay ? { ...jdPay, from: "description" } : storedPay ? { ...storedPay, basis: "base", band: "board", from: "stored" } : textPay ? { ...textPay, basis: "base", band: "listing", from: "description" } : null;
    const tier = locationTier(location);
    const flags = benefitFlags(desc);
    const relevanceV1 = relevanceScore(roleForScoring, desc, targets);
    const relevance = useV2 ? relevanceV2(roleForScoring, desc) : relevanceV1;
    const fit = fitByUrl.get(r.url) ?? null;
    const level = levelFit(roleForScoring, r.company, desc, levelCfg);
    const employment = employmentType(roleForScoring, desc);
    const compEntry = compFor(r.company, compMap);
    const tcEst = techComp ? bestTcEstimate({ company: r.company, title: roleForScoring, levelKey: level.key, pay, locationTier: tier }, { levelsMap, compMap, homeLocation: levelsHome, homeFactor: tcHomeFactor }) : null;
    const useTc = payBasis === "tc" && tcEst && confidenceAtLeast(tcEst.confidence, "medium");
    const belowFloor = isBelowFloor(pay, baseFloor);
    const parts = {
      level: Math.round(level.factor * 100),
      fit: fitToPct(fit),
      relevance,
      pay: belowFloor ? 0 : useTc ? tcScore(tcEst.rankUsd, tcBand) : (payScore(pay, band) ?? payMissing),
      company: researchTier.has(normCompany(r.company)) ? Math.round(researchTier.get(normCompany(r.company)) * 100) : companyScore(compEntry),
      location: tier ? (locationScores[tier] ?? LOCATION_TIER_SCORE[tier]) : null,
      benefits: benefitScore(flags),
    };
    out[r.url] = {
      company: r.company,
      role: r.role,
      location,
      source: r.source,
      status: statusByUrl.get(r.url) ?? null,
      pay: pay ? { min: pay.min, max: pay.max, currency: pay.currency, period: pay.period, annualMin: pay.annualMin, annualMax: pay.annualMax, from: pay.from, basis: pay.basis, band: pay.band } : null,
      group: groupKey(r.company, roleForScoring),
      displayRole: hn ? roleForScoring : undefined,
      // Not full-time (contract, part-time, temporary, freelance, internship): lib/hunt-employment.mjs.
      // With exclude_contract: true the job leaves the ranking, the Jobs list and every Sonnet pick.
      contract: hn?.contract || Boolean(employment) || undefined,
      employment: employment ?? undefined,
      // exclude_below_floor: a posted base band topping out under base_floor is hidden the same way.
      excluded: excludeContract && (hn?.contract || employment) ? "not full-time" : excludeBelowFloor && belowFloor ? `below the ${Math.round((baseFloor ?? 0) / 1000)}k base floor` : undefined,
      origin: originOf(r),
      channel: channelOf(r, originOf(r)),
      domains: relevanceDomains(desc),
      relevanceV1,
      tc_est: tcEst ?? undefined,
      tc_adj: tcEst?.rankUsd ?? undefined,
      belowFloor: belowFloor || undefined,
      floor: belowFloor ? baseFloor : undefined,
      lca: techComp ? lcaFor(lca, r.company, compEntry) : undefined,
      payFrom: useTc ? "tc" : pay ? "base" : payMissing != null ? "placeholder" : undefined,
      companyTier: compEntry?.tier ?? undefined,
      researchTier: researchTier.get(normCompany(r.company)) ?? undefined,
      caution: caution.has(normCompany(r.company)) || undefined,
      identityUnverified: unverified.has(String(r.company).trim().toLowerCase()) || undefined,
      companyStage: compEntry?.stage ?? undefined,
      // hunt: the board's posting date (YYYY-MM-DD), for the "Posted Nmo ago" chip and stale demotion.
      postedAt: /^\d{4}-\d{2}-\d{2}$/.test(String(r.posted ?? "")) ? r.posted : undefined,
      stabilityNote: compEntry?.stabilityNote ?? undefined,
      locationTier: tier,
      locationLabel: tier ? locationLabels[tier] : undefined,
      benefits: flags,
      relevance,
      relevanceEst: desc.trim().length < THIN_JD_CHARS || undefined,
      level: { key: level.key, label: level.label, factor: level.factor },
      fit,
      // hunt: a job that was scored only through its group keeps that group score as prev_fit.
      prev_fit: prevFits[r.url]?.reeval_ok ? (typeof prevFits[r.url].prev_fit === "number" ? prevFits[r.url].prev_fit : typeof prevFits[r.url].prev_group_fit === "number" ? prevFits[r.url].prev_group_fit : undefined) : undefined,
      fitModel: prevFits[r.url]?.reeval_ok ? prevFits[r.url].reeval_model : undefined,
      report: reportByUrl.get(r.url) ?? null,
      parts,
      composite: boostedComposite(parts, weights, companyBoost(r.company, boosts)),
      boost: companyBoost(r.company, boosts) || undefined,
      rankBoost: rankBoostCos.has(normCompany(r.company)) || undefined,
      hasDescription: !!desc,
      jdChars: desc.length || undefined,
    };
  }
  // Groups: one leader per company + base title (on-target level/place, then best own fit, then composite).
  const groups = new Map();
  for (const [url, e] of Object.entries(out)) {
    if (!groups.has(e.group)) groups.set(e.group, []);
    groups.get(e.group).push(url);
  }
  const shortlistCfg = { minRelevance: Number(rankingShortlist?.min_relevance ?? 52) };
  let shortlisted = 0;
  for (const urls of groups.values()) {
    urls.sort(groupLeaderOrder(out, target));
    urls.forEach((u, i) => { out[u].groupSize = urls.length; out[u].groupLeader = i === 0; out[u].groupUrls = i === 0 ? urls.slice(1) : undefined; });
    const lead = out[urls[0]];
    // Like-for-like children inherit the representative's fit ("scored via group"); a member at
    // a different level or place is a different job, so it stays unevaluated (its quick score shows).
    if (lead.fit != null) {
      for (const u of urls.slice(1)) {
        const e = out[u];
        if (e.fit != null) continue;
        if (!sameLevelAndPlace(e, lead)) continue;
        e.fit = lead.fit;
        e.fitVia = "group";
        e.fitFrom = urls[0];
        e.parts.fit = fitToPct(lead.fit);
        e.composite = boostedComposite(e.parts, weights, e.boost ?? 0);
      }
    }
    // A group can bundle different roles (company + base title); its best own evaluation counts,
    // so a 4.0+ member is not hidden behind a weaker leader.
    const bestOwnFit = Math.max(-1, ...urls.map((u) => (out[u].fitVia !== "group" && typeof out[u].fit === "number" ? out[u].fit : -1)));
    const levelOk = shortlistLevelOk(lead, target) || shortlistLevelOk({ fit: bestOwnFit, level: { key: "" } }, target);
    const placeOk = placeOnTarget(lead, target);
    const open = !["Rejected", "Discarded", "SKIP", "Hired"].includes(String(lead.status ?? "")) && !/^(skip|discard)/i.test(String(lead.report?.decision ?? ""));
    const ok = open && levelOk && placeOk && !lead.contract && !lead.belowFloor && (lead.fit != null ? Math.max(lead.fit, bestOwnFit) >= 3.5 : (!lead.relevanceEst && (lead.relevance ?? 0) >= shortlistCfg.minRelevance) || (lead.boost ?? 0) > 0);
    for (const u of urls) { out[u].shortlist = ok && u === urls[0]; out[u].groupShortlist = ok; }
    if (ok) shortlisted++;
  }
  // Quick 1-5 scores (scripts/hunt-quickscore.mjs): one short Haiku read per posting.
  try {
    const q = JSON.parse(readText(path.join(root, "data", "hunt-quick.json"))).scores ?? {};
    for (const [u, v] of Object.entries(q)) if (out[u] && v && Number.isFinite(Number(v.score))) { out[u].quick_score = Number(v.score); out[u].quick_why = String(v.why ?? "").slice(0, 160) || undefined; }
  } catch { /* none yet */ }
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, "snippets.json"), JSON.stringify(snippets)); } catch { /* best effort */ }
  // Sonnet head-to-head (scripts/hunt-h2h.mjs): Borda rank of the top ~100 groups.
  let h2hMeta = null;
  try {
    const h = JSON.parse(readText(path.join(root, "data", "hunt-h2h.json")));
    h2hMeta = { generatedAt: h.generatedAt, n: (h.items ?? []).length, rounds: h.rounds };
    for (const it of h.items ?? []) {
      const e = out[it.url];
      if (!e) continue;
      e.h2h_rank = it.h2h_rank;
      e.h2hWhy = it.why || undefined;
      for (const g of groups.get(e.group) ?? []) if (g !== it.url && out[g].h2h_rank == null) { out[g].h2h_rank = it.h2h_rank; out[g].h2hVia = "group"; }
    }
  } catch { /* no head-to-head yet */ }
  // hunt: a stable first_seen_at per job (data/first-seen.json), set once, never overwritten.
  try {
    const trackerDates = new Map(tracker.filter((t) => t.url && /^\d{4}-\d{2}-\d{2}$/.test(String(t.date ?? ""))).map((t) => [t.url, String(t.date)]));
    updateFirstSeen(root, Object.keys(out), { trackerDates });
    const seenDoc = JSON.parse(readText(path.join(root, "data", "first-seen.json")) || "{}");
    for (const [u, e] of Object.entries(out)) if (seenDoc.jobs?.[u]) e.first_seen_at = seenDoc.jobs[u];
  } catch (e) { console.warn(`first-seen: ${e.message}`); }
  const person = readPerson(root);
  const display = { baseFloor, currency, locationLabels, levelTarget: person.level_target || null, roleFamilies: mapFamilies(mapFamiliesCfg, person) };
  const doc = { generatedAt: new Date().toISOString(), display, h2h: h2hMeta, groups: groups.size, shortlisted, shortlistMinRelevance: shortlistCfg.minRelevance, weights, payBand: band, counts: { total: all.length, withDescription: withDesc }, boards: fetchLog, jobs: out };
  fs.writeFileSync(`${OUT}.tmp`, JSON.stringify(doc, null, 1));
  fs.renameSync(`${OUT}.tmp`, OUT);
  return doc;
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);
  const doc = await enrich();
  const jobs = Object.values(doc.jobs);
  const errors = doc.boards.filter((b) => /error/.test(b.from));
  log(`hunt-enrich: ${jobs.length} postings, ${doc.counts.withDescription} with a description, ${jobs.filter((j) => j.pay).length} with pay, ${jobs.filter((j) => j.fit != null).length} with fit`);
  for (const e of errors) log(`  board ${e.board}: ${e.from}`);
  log(`wrote ${path.relative(root, OUT)}`);
}
