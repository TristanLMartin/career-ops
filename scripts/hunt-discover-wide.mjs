#!/usr/bin/env node
// hunt-discover-wide: widen discovery to startups and small companies.
// Config: config/discovery-wide.yml. Public, login-free sources only; anything
// that answered with a login wall or a bot block is listed under `skipped` there.
//
//   boards   Recruiter-named companies -> verified ATS boards (Greenhouse / Lever / Ashby /
//            Workable / Breezy / Rippling). A slug is accepted only when that board's own
//            API or page names the company (or its domain).
//   vc       VC portfolio boards (Getro, a16z speedrun), Built In and the ATS
//            boards linked from non-Getro portfolio pages -> data/discovery-vc.yml, scanned
//            by scan.mjs with portals.yml's title/location filters. Plus YC's public
//            ycombinator.com/jobs listings, ingested through Add-a-job (source discovery-yc).
//   funding  GeekWire funding + TechCrunch venture RSS, last 90 days: Series A-C rounds in
//            payments / real-time / infra / dev tools / AI tooling -> company names ->
//            verified boards (as in `boards`).
//
//   targets  Named target companies (config `targets`: ATS boards and big-tech careers APIs,
//            narrowed server-side where the provider allows) -> data/discovery-targets.yml,
//            scanned by scan.mjs with portals.yml's title/location filters (strict location).
//
// Boards found by `boards` and `funding` join data/hunt-discovery.json (source
// "recruiter" / "funding-<feed>"), so scripts/hunt-discover.mjs writes them into
// data/discovery-boards.yml and every scan reads them. portals.yml is never touched.
// Zero AI tokens. Never applies or sends anything. Fetched content is untrusted data.
//
// Usage: node scripts/hunt-discover-wide.mjs boards|vc|funding|targets [--dry-run]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { loadYaml } from "../lib/yaml-document.mjs";
import { boardsInText, watchedSlugs, watchedNames, runDiscoveryScan } from "./hunt-discover.mjs";
import { exitOnHelp } from "../lib/cli-guard.mjs";

export const UA = "career-ops-hunt-discover/1.0 (personal job search; low volume)";
const HERE = path.dirname(new URL(import.meta.url).pathname);

function readText(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with the honest UA. Returns {status, text}; never throws. */
export async function httpGet(url, { accept = "*/*", timeout = 20000 } = {}) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, redirect: "follow", signal: AbortSignal.timeout(timeout) });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    return { status: 0, text: "", error: String(e?.message ?? e) };
  }
}

export function loadWideConfig(root) {
  try { return loadYaml(readText(path.join(root, "config", "discovery-wide.yml"))) ?? {}; } catch { return {}; }
}

// ── Name matching and slug probes ─────────────────────────────────────────

const NAME_NOISE = /\b(the|inc|incorporated|llc|ltd|corp|corporation|co|company|group|technologies|technology|labs|hq|holdings)\b/g;
export function normName(s) {
  return String(s ?? "").toLowerCase().replace(/&/g, " and ").replace(NAME_NOISE, " ").replace(/[^a-z0-9]+/g, "");
}

/** Does `found` (a board's own name/title) name `want`? Exact after normalizing, or one
 *  contains the other when the shorter side is at least 4 characters. */
export function namesMatch(want, found) {
  const a = normName(want), b = normName(found);
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 4 && l.startsWith(s);
}

/** Slug guesses for a company name: given hints first, then the usual spellings. */
export function candidateSlugs(name, hints = []) {
  const base = String(name ?? "").toLowerCase().replace(/^the\s+/, "").replace(/[,.]|\binc\b|\bllc\b/g, "").trim();
  const words = base.split(/[^a-z0-9]+/).filter(Boolean);
  const out = [...hints.map((h) => String(h).toLowerCase())];
  if (words.length) {
    out.push(words.join(""), words.join("-"), words[0]);
    if (words.length > 1) out.push(words.join("_"));
    out.push(`${words.join("")}hq`, `${words.join("")}inc`);
  }
  return [...new Set(out)].filter((s) => /^[a-z0-9][a-z0-9_-]{1,60}$/.test(s));
}

const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };

/**
 * Probe one slug on every supported ATS. Returns the first verified board or null.
 * `get(url)` -> {status, text}. Verification per ATS:
 *  - greenhouse: /v1/boards/{slug} returns {name}
 *  - ashby: the hosted page carries "name":"…","publicWebsite":"…" (or <title>{name} Jobs)
 *  - lever: <title> of jobs.lever.co/{slug}
 *  - workable: widget API {name}, with at least one job
 *  - breezy: {slug}.breezy.hr/json lists jobs and a posting page names the company or domain
 *  - rippling: board API answers and its page title names the company
 */
export async function probeSlug(want, slug, { domain = "", get = httpGet, requireDomain = false, context = "" } = {}) {
  const b = await probeSlugByName(want, slug, { domain, get });
  if (!b || !requireDomain) return b;
  // Strict (funding news): the board must also name the company's own domain, taken from the
  // article's links, so a same-named company elsewhere is not picked up.
  if (!domain && !context) return null;
  const evidenceUrl = b.provider === "greenhouse" ? `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true` : b.provider === "breezy" ? `${b.careers_url}/` : b.careers_url;
  const ev = await get(evidenceUrl);
  if (ev.status !== 200) return null;
  const body = ev.text.toLowerCase();
  if (domain && body.includes(domain.toLowerCase())) return { ...b, verifiedBy: `domain ${domain}` };
  // Boards that never print their domain (Greenhouse job bodies rarely do): the article's own
  // words about what the company does must show up on the board, at least two of them.
  const words = contextWords(context, want);
  const hits = words.filter((w) => body.includes(w));
  return hits.length >= 2 ? { ...b, verifiedBy: `article words ${hits.slice(0, 4).join(", ")}` } : null;
}

const STOP = new Set(["about", "after", "their", "there", "which", "while", "would", "could", "should", "where", "these", "those", "raises", "raised", "funding", "round", "series", "million", "billion", "startup", "seattle", "company", "investors", "investment", "venture", "capital", "valuation", "growth", "build", "launch", "helps", "using", "other", "people", "years", "first", "former", "leaders", "founded", "based"]);
/** Distinctive words from an article headline, minus the company's own name. */
export function contextWords(context, name = "") {
  const own = new Set(String(name).toLowerCase().split(/[^a-z0-9]+/));
  return [...new Set(String(context ?? "").toLowerCase().replace(/[\u2018\u2019']/g, "").split(/[^a-z0-9-]+/).filter((w) => w.length >= 5 && !STOP.has(w) && !own.has(w)))];
}

async function probeSlugByName(want, slug, { domain = "", get = httpGet } = {}) {
  const ok = (found, site) => namesMatch(want, found) || (domain && site && domainOf(site).endsWith(domain));
  // Greenhouse
  {
    const r = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}`, { accept: "application/json" });
    if (r.status === 200) {
      let name = ""; try { name = JSON.parse(r.text).name ?? ""; } catch {}
      if (ok(name, "")) return { provider: "greenhouse", slug, careers_url: `https://job-boards.greenhouse.io/${slug}`, verifiedAs: name.trim() };
    }
  }
  // Ashby
  {
    const r = await get(`https://jobs.ashbyhq.com/${slug}`);
    if (r.status === 200) {
      const m = r.text.match(/"name":"([^"]{1,80})","publicWebsite":"([^"]*)"/);
      const title = r.text.match(/<title>([^<]{1,100}?)\s+Jobs\s*<\/title>/i)?.[1] ?? "";
      const name = m?.[1] ?? title;
      if (ok(name, m?.[2] ?? "")) {
        const api = await get(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, { accept: "application/json" });
        if (api.status === 200) return { provider: "ashby", slug, careers_url: `https://jobs.ashbyhq.com/${slug}`, verifiedAs: name };
        return { provider: "ashby", slug, careers_url: `https://jobs.ashbyhq.com/${slug}`, verifiedAs: name, unreadable: "Ashby public posting API is off for this board" };
      }
    }
  }
  // Lever
  {
    const r = await get(`https://jobs.lever.co/${slug}`);
    if (r.status === 200) {
      const title = r.text.match(/<title>([^<]{1,100})<\/title>/i)?.[1]?.trim() ?? "";
      if (ok(title, "")) return { provider: "lever", slug, careers_url: `https://jobs.lever.co/${slug}`, verifiedAs: title };
    }
  }
  // Workable
  {
    const r = await get(`https://apply.workable.com/api/v1/widget/accounts/${slug}`, { accept: "application/json" });
    if (r.status === 200) {
      let d = {}; try { d = JSON.parse(r.text); } catch {}
      if (Array.isArray(d.jobs) && d.jobs.length && ok(d.name ?? "", "")) return { provider: "workable", slug, careers_url: `https://apply.workable.com/${slug}/`, verifiedAs: d.name };
    }
  }
  // Breezy
  {
    const r = await get(`https://${slug}.breezy.hr/json`, { accept: "application/json" });
    if (r.status === 200) {
      let jobs = []; try { jobs = JSON.parse(r.text); } catch {}
      if (Array.isArray(jobs) && jobs.length) {
        const page = await get(`https://${slug}.breezy.hr/`);
        const title = page.text.match(/<title>([^<]{1,120})<\/title>/i)?.[1] ?? "";
        if (ok(title.replace(/\s*[-|–].*$/, ""), "") || (domain && page.text.toLowerCase().includes(domain)) || jobs.some((j) => ok(j.company?.name ?? "", ""))) {
          return { provider: "breezy", slug, careers_url: `https://${slug}.breezy.hr`, verifiedAs: title.trim() || slug };
        }
      }
    }
  }
  // Rippling
  {
    const r = await get(`https://ats.rippling.com/api/v2/board/${slug}/jobs?page=0&pageSize=1`, { accept: "application/json" });
    if (r.status === 200) {
      const page = await get(`https://ats.rippling.com/${slug}/jobs`);
      const title = page.text.match(/<title>([^<]{1,120})<\/title>/i)?.[1] ?? "";
      if (ok(title.replace(/\s*(careers|jobs).*$/i, ""), "") || (domain && page.text.toLowerCase().includes(domain))) {
        return { provider: "rippling", slug, careers_url: `https://ats.rippling.com/${slug}/jobs`, verifiedAs: title.trim() || slug };
      }
    }
  }
  return null;
}

/** First verified board for a company over its candidate slugs. */
export async function findBoard(company, { get = httpGet, pause = 300, requireDomain = false } = {}) {
  for (const slug of candidateSlugs(company.name, company.slugs ?? [])) {
    const b = await probeSlug(company.name, slug, { domain: company.domain ?? "", get, requireDomain, context: company.context ?? "" });
    if (b) return b;
    if (pause) await sleep(pause);
  }
  return null;
}

/** Add verified boards to data/hunt-discovery.json (deduped; watched ones skipped). */
export function mergeDiscoveredBoards(root, found, { now = new Date() } = {}) {
  const stateFile = path.join(root, "data", "hunt-discovery.json");
  let state = { boards: [], threads: [] };
  try { state = JSON.parse(readText(stateFile)) || state; } catch {}
  const portalsText = readText(path.join(root, "portals.yml"));
  const watched = watchedSlugs(portalsText);
  const names = watchedNames(portalsText);
  const known = new Map((state.boards ?? []).map((b) => [`${b.provider}:${b.slug}`, b]));
  const added = [], skipped = [];
  for (const b of found) {
    const k = `${b.provider}:${b.slug}`;
    if (watched.has(k) || names.has(String(b.name).toLowerCase())) { skipped.push({ ...b, why: "already on the portals.yml watchlist" }); continue; }
    if (b.unreadable) { skipped.push({ ...b, why: b.unreadable }); continue; }
    if (known.has(k)) { skipped.push({ ...b, why: "already discovered" }); continue; }
    const entry = { provider: b.provider, slug: b.slug, careers_url: b.careers_url, name: b.name, source: b.source, firstSeen: now.toISOString().slice(0, 10) };
    known.set(k, entry);
    added.push(entry);
  }
  state.boards = [...known.values()];
  state.updatedAt = now.toISOString();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
  return { added, skipped };
}

function regenerateDiscoveryBoards(root) {
  // hunt-discover.mjs rewrites data/discovery-boards.yml from the state file.
  return spawnSync(process.execPath, [path.join(HERE, "hunt-discover.mjs"), "--no-fetch"], { cwd: root, env: { ...process.env, CAREER_OPS_ROOT: root }, encoding: "utf8", timeout: 120000 });
}

// ── Recruiter-named companies ─────────────────────────────────────────────

/** Companies named in recruiter messages (data/hunt-messages*.jsonl), excluding automated mail. */
export function recruiterCompanies(root) {
  const out = new Map();
  for (const f of fs.readdirSync(path.join(root, "data")).filter((n) => /^hunt-messages.*\.jsonl$/.test(n))) {
    for (const line of readText(path.join(root, "data", f)).split("\n")) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!o?.company || o.automated) continue;
      const name = String(o.company).trim();
      if (name && name.length <= 60) out.set(normName(name), name);
    }
  }
  return [...out.values()];
}

export async function boardsFromRecruiters({ root = getCareerOpsRoot(), get = httpGet, dryRun = false, bigCompanies = [] } = {}) {
  const cfg = loadWideConfig(root);
  const listed = (cfg.recruiter_companies ?? []).map((c) => ({ ...c }));
  const have = new Set(listed.map((c) => normName(c.name)));
  const big = new Set(bigCompanies.map(normName));
  for (const name of recruiterCompanies(root)) if (!have.has(normName(name)) && !big.has(normName(name))) listed.push({ name });
  const results = [];
  for (const c of listed) results.push({ company: c.name, board: await findBoard(c, { get }) });
  const found = results.filter((r) => r.board).map((r) => ({ ...r.board, name: r.company, source: "recruiter" }));
  const merged = dryRun ? { added: found, skipped: [] } : mergeDiscoveredBoards(root, found);
  if (!dryRun && merged.added.length) regenerateDiscoveryBoards(root);
  return { results, ...merged };
}

// ── YC public job listings ────────────────────────────────────────────────

const decodeAttr = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** ycombinator.com/jobs/... page -> [{company, title, location, salary, url}] from its data-page JSON. */
export function parseYcPage(html) {
  const m = String(html ?? "").match(/data-page="([^"]+)"/);
  if (!m) return [];
  let d; try { d = JSON.parse(decodeAttr(m[1])); } catch { return []; }
  const posts = d?.props?.jobPostings;
  if (!Array.isArray(posts)) return [];
  return posts
    .filter((p) => p && typeof p.url === "string" && p.url.startsWith("/companies/") && p.title && p.companyName)
    .filter((p) => !p.type || /full/i.test(p.type))
    .map((p) => ({ company: String(p.companyName).slice(0, 120), title: String(p.title).slice(0, 200), location: String(p.location ?? "").slice(0, 160), salary: String(p.salaryRange ?? "").slice(0, 80), url: `https://www.ycombinator.com${p.url.split("?")[0]}`, batch: p.companyBatchName ?? "" }));
}

// ── VC portfolio boards ───────────────────────────────────────────────────

function filterConfig(portals) {
  const keep = {};
  for (const k of Object.keys(portals ?? {})) if (k !== "tracked_companies" && k !== "search_queries" && k !== "job_boards") keep[k] = portals[k];
  // Discovery fails closed: a posting with no stated location is dropped, not "anywhere".
  if (keep.location_filter) keep.location_filter = { ...keep.location_filter, strict: true };
  return keep;
}

/** data/discovery-vc.yml from the config, plus boards mined from portfolio pages. */
export function vcPortals(cfg, portals, minedBoards = []) {
  const jobBoards = [
    ...(cfg.vc_boards ?? []).map((b) => ({ name: b.name, provider: b.provider, ...(b.careers_url ? { careers_url: b.careers_url } : {}), enabled: true })),
    ...(cfg.builtin ?? []).map((b) => ({ name: b.name, provider: "builtin", builtin: { host: b.host, ...(b.scope ? { scope: b.scope } : {}), ...(b.queries ? { queries: b.queries } : { categories: b.categories ?? ["dev-engineering"] }), ...(b.queries && b.categories ? { categories: b.categories } : {}), max_pages: b.max_pages ?? 3 }, enabled: true })),
  ];
  const tracked = minedBoards.map((b) => ({ name: b.name, careers_url: b.careers_url, ...(b.provider === "greenhouse" ? { api: `https://boards-api.greenhouse.io/v1/boards/${b.slug}/jobs` } : {}), enabled: true, ...(b.source ? { notes: `discovery:${b.source}` } : {}) }));
  return { ...filterConfig(portals), job_boards: jobBoards, tracked_companies: tracked };
}

/** Company name for a mined board: the slug, title-cased (the page's own label is unreliable). */
const slugName = (slug) => slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export async function vc({ root = getCareerOpsRoot(), get = httpGet, add, dryRun = false, scan = true } = {}) {
  const cfg = loadWideConfig(root);
  const portalsText = readText(path.join(root, "portals.yml"));
  const portals = loadYaml(portalsText) ?? {};
  const watched = watchedSlugs(portalsText);
  let state = { boards: [] };
  try { state = JSON.parse(readText(path.join(root, "data", "hunt-discovery.json"))) || state; } catch {}
  const discovered = new Set((state.boards ?? []).map((b) => `${b.provider}:${b.slug}`));
  const pages = [];
  const mined = new Map();
  for (const p of cfg.portfolio_pages ?? []) {
    const r = await get(p.url);
    const boards = r.status === 200 ? boardsInText(r.text) : [];
    pages.push({ name: p.name, status: r.status, boards: boards.length });
    for (const b of boards) {
      const k = `${b.provider}:${b.slug}`;
      if (watched.has(k) || discovered.has(k) || mined.has(k)) continue;
      mined.set(k, { ...b, name: slugName(b.slug), source: `vc-${normName(p.name).replace(/portfolio$/, "")}` });
    }
  }
  const yml = vcPortals(cfg, portals, [...mined.values()]);
  const file = path.join(root, "data", "discovery-vc.yml");
  if (!dryRun) fs.writeFileSync(file, `# Generated by scripts/hunt-discover-wide.mjs vc. Do not edit; edit config/discovery-wide.yml.\n${JSON.stringify(yml, null, 1)}\n`);
  let scanResult = null;
  if (!dryRun && scan) scanResult = runDiscoveryScan(root, "vc");

  // YC listings through Add-a-job.
  const yc = { pages: 0, found: 0, kept: 0, added: 0, duplicate: 0, other: 0, jobs: [] };
  const { portalsFilters } = await import("./hunt-discovery-boards.mjs");
  const passes = await portalsFilters(root);
  const addFn = add ?? (await import("./hunt-add-job.mjs")).addJob;
  const seen = new Set();
  for (const u of cfg.yc_pages ?? []) {
    const r = await get(u);
    if (r.status !== 200) continue;
    yc.pages++;
    for (const j of parseYcPage(r.text)) {
      if (seen.has(j.url)) continue;
      seen.add(j.url);
      yc.found++;
      if (!passes(j)) continue;
      yc.kept++;
      if (dryRun) { yc.jobs.push(j); continue; }
      const res = await addFn({ url: j.url, company: j.company, title: j.title, location: j.location, jd: j.salary ? `Salary: ${j.salary}` : "" }, { root, enrich: false, source: "discovery-yc" });
      if (res.status === "added") { yc.added++; yc.jobs.push(j); } else if (res.status === "duplicate") yc.duplicate++; else yc.other++;
    }
    await sleep(1000);
  }
  return { pages, mined: mined.size, file, scan: scanResult, yc };
}

// ── Named target companies ────────────────────────────────────────────────

/** data/discovery-targets.yml from config `targets` (entries are portals.yml entries). */
export function targetPortals(cfg, portals) {
  const tracked = (cfg.targets ?? []).filter((t) => t && t.name && t.careers_url).map((t) => {
    const e = { ...t, enabled: t.enabled ?? true, notes: "discovery:target" };
    const gh = String(t.careers_url).match(/greenhouse\.io\/([a-z0-9_-]+)/i);
    if (gh && !e.api && !e.provider) e.api = `https://boards-api.greenhouse.io/v1/boards/${gh[1]}/jobs`;
    return e;
  });
  return { ...filterConfig(portals), tracked_companies: tracked };
}

export function targets({ root = getCareerOpsRoot(), dryRun = false, scan = true } = {}) {
  const cfg = loadWideConfig(root);
  const portals = loadYaml(readText(path.join(root, "portals.yml"))) ?? {};
  const yml = targetPortals(cfg, portals);
  const file = path.join(root, "data", "discovery-targets.yml");
  if (!dryRun) fs.writeFileSync(file, `# Generated by scripts/hunt-discover-wide.mjs targets. Do not edit; edit config/discovery-wide.yml.\n${JSON.stringify(yml, null, 1)}\n`);
  return { entries: yml.tracked_companies.length, file, scan: !dryRun && scan ? runDiscoveryScan(root, "targets") : null };
}

// ── Funding news ──────────────────────────────────────────────────────────

const ROUND = /\bseries\s+([abc])\b/i;
const unescapeXml = (s) => String(s ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&#8217;|&rsquo;/g, "'").replace(/&#8216;/g, "'").replace(/&#8220;|&#8221;|&quot;/g, '"').replace(/&#8211;|&#8212;/g, "-").replace(/&#038;|&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const VERB = /\s(?:raises|lands|secures|nabs|closes|snags|collects|bags|scores|reels in|announces \$|lands \$)/;
/** Company name from a funding headline, or null. */
export function fundingCompany(title) {
  let t = unescapeXml(title).replace(/[\u2018\u2019]/g, "'").replace(/^[A-Z][\w ]{0,20}:\s+/, ""); // "Filing: ..."
  const v = t.match(VERB);
  if (!v) return null;
  let head = t.slice(0, v.index).split(/,\s/)[0].trim(); // "StepSecurity, led by ..." -> "StepSecurity"
  // "Seattle startup X", "Chip startup X", "Seattle-area ag-tech startup X", "Seattle's X".
  head = head.replace(/^.*?\b(?:startup|company|firm|unicorn|spinout|maker|platform|provider)\s+/i, "");
  head = head.replace(/^(?:[A-Z][\w-]*'s)\s+/, "");
  head = head.replace(/^(?:Seattle|Bellevue|Redmond|Portland|Vancouver|Boston|Former|Ex-\w+)(?:-area)?\s+/i, "");
  const m = head.match(/^([A-Z0-9][\w.&'-]*(?: [A-Z0-9][\w.&'-]*){0,3})$/);
  if (!m) return null;
  const name = m[1].replace(/'s$/, "").trim();
  if (name.length < 2 || /^(the|a|an|this|it|startup|why|how|new)$/i.test(name) || /\b(ventures|capital|partners|fund)$/i.test(name)) return null;
  return name;
}

/** Round from the text: "A"/"B"/"C" when stated, "seed"/"late" when that is stated instead, else null. */
export function fundingRound(text) {
  const r = String(text).match(ROUND)?.[1];
  if (r) return r.toUpperCase();
  if (/\bseries\s+[d-z]\b|\bIPO\b|\bpublic offering\b/i.test(text)) return "late";
  if (/\b(pre-seed|seed)\b/i.test(text)) return "seed";
  return null;
}

/** First dollar amount in millions ("$20M", "$1.1B" -> 1100), or null. */
export function fundingAmount(text) {
  const m = String(text).match(/\$(\d+(?:\.\d+)?)\s*(M|B|million|billion)\b/i);
  if (!m) return null;
  return Number(m[1]) * (/^b/i.test(m[2]) ? 1000 : 1);
}

/** The company's own site among the article's links: a host whose first label resembles the name. */
export function companyDomain(name, itemXml) {
  const want = normName(name);
  if (!want) return "";
  for (const m of String(itemXml ?? "").matchAll(/href=["'](https?:\/\/[^"']+)["']/g)) {
    const host = domainOf(m[1]);
    const label = normName(host.split(".")[0]);
    if (label.length >= 3 && (label.startsWith(want.slice(0, Math.max(4, Math.min(want.length, 6)))) || want.startsWith(label))) return host;
  }
  return "";
}

/** RSS xml -> [{title, link, date, text, company, round}] within `days` of `now`. */
export function parseFundingRss(xml, { now = new Date(), days = 90 } = {}) {
  const out = [];
  for (const m of String(xml ?? "").matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const title = unescapeXml(it.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const link = unescapeXml(it.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "");
    const date = new Date(it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "");
    if (!title || Number.isNaN(date.getTime())) continue;
    if (now - date > days * 86400000) continue;
    const text = `${title} ${unescapeXml(it.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "")} ${unescapeXml(it.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/)?.[1] ?? "").slice(0, 4000)}`;
    const company = fundingCompany(title);
    out.push({ title, link, date: date.toISOString().slice(0, 10), text, company, domain: companyDomain(company, it), round: fundingRound(text), amountM: fundingAmount(title) ?? fundingAmount(text) });
  }
  return out;
}

/** Series A-C in a target sector, with a company name. A round the story doesn't name counts
 *  as A-C when the amount is $8M-$150M (typical A-C sizes); seed, late stage and unknown
 *  amounts are left out. */
export function fundingCandidates(items, sectors = []) {
  const sec = sectors.map((s) => String(s).toLowerCase());
  const seen = new Set();
  return items.filter((i) => {
    if (!i.company) return false;
    const stated = ["A", "B", "C"].includes(i.round);
    const inferred = i.round == null && i.amountM != null && i.amountM >= 8 && i.amountM <= 150;
    if (!stated && !inferred) return false;
    const t = i.text.toLowerCase();
    if (sec.length && !sec.some((s) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t))) return false;
    const k = normName(i.company);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function funding({ root = getCareerOpsRoot(), get = httpGet, dryRun = false, now = new Date() } = {}) {
  const cfg = loadWideConfig(root);
  const days = Number(cfg.funding_days ?? 90);
  const feeds = [];
  const items = [];
  for (const f of cfg.funding_feeds ?? []) {
    let n = 0, status = 0;
    for (let p = 1; p <= Number(f.pages ?? 1); p++) {
      const r = await get(p === 1 ? f.url : `${f.url}?paged=${p}`, { accept: "application/rss+xml, application/xml" });
      status = r.status;
      if (r.status !== 200) break;
      const parsed = parseFundingRss(r.text, { now, days }).map((i) => ({ ...i, feed: f.name }));
      items.push(...parsed);
      n += parsed.length;
      if (!parsed.length) break; // past the window
      await sleep(1500);
    }
    feeds.push({ name: f.name, status, items: n });
  }
  const cands = fundingCandidates(items, cfg.funding_sectors ?? []);
  const results = [];
  for (const c of cands) results.push({ company: c.company, round: c.round, feed: c.feed, date: c.date, title: c.title, board: await findBoard({ name: c.company, domain: c.domain, context: c.title }, { get, requireDomain: true }) });
  const found = results.filter((r) => r.board).map((r) => ({ ...r.board, name: r.company, source: `funding-${r.feed}` }));
  const merged = dryRun ? { added: found, skipped: [] } : mergeDiscoveredBoards(root, found, { now });
  if (!dryRun && merged.added.length) regenerateDiscoveryBoards(root);
  return { feeds, items: items.length, candidates: cands.length, results, ...merged };
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);
  const cmd = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  const root = getCareerOpsRoot();
  if (cmd === "boards") {
    let big = [];
    try { big = (loadYaml(readText(path.join(root, "config", "ranking.yml"))) ?? {}).level?.big_companies ?? []; } catch {}
    const r = await boardsFromRecruiters({ root, dryRun, bigCompanies: [...big, "Amazon", "Microsoft", "Google", "Meta", "Apple", "Salesforce"] });
    for (const x of r.results) console.log(`  ${x.company}: ${x.board ? `${x.board.provider}:${x.board.slug} (verified as "${x.board.verifiedAs}")${x.board.unreadable ? ` [${x.board.unreadable}]` : ""}` : "no verified board"}`);
    console.log(`hunt-discover-wide boards: ${r.added.length} added, ${r.skipped.length} skipped${r.skipped.length ? ` (${r.skipped.map((s) => `${s.name}: ${s.why}`).join("; ")})` : ""}`);
  } else if (cmd === "vc") {
    const r = await vc({ root, dryRun });
    console.log(`hunt-discover-wide vc: portfolio pages ${r.pages.map((p) => `${p.name} HTTP ${p.status} ${p.boards} boards`).join(", ")}; ${r.mined} new boards mined; scan ${r.scan ? `exit ${r.scan.status}, ${r.scan.companies} sources, ${r.scan.added} new roles, ${r.scan.errors} errors` : "skipped"}; YC ${r.yc.pages} pages, ${r.yc.found} found, ${r.yc.kept} passed filters, ${r.yc.added} added, ${r.yc.duplicate} duplicates`);
    if (!dryRun) spawnSync(process.execPath, [path.join(HERE, "hunt-enrich.mjs"), "--no-fetch", "--quiet"], { cwd: root, env: { ...process.env, CAREER_OPS_ROOT: root }, stdio: "ignore", timeout: 600000 });
  } else if (cmd === "funding") {
    const r = await funding({ root, dryRun });
    console.log(`hunt-discover-wide funding: feeds ${r.feeds.map((f) => `${f.name} HTTP ${f.status} ${f.items} items`).join(", ")}; ${r.candidates} Series A-C candidates in target sectors; ${r.results.filter((x) => x.board).length} with a verified board; ${r.added.length} added`);
    for (const x of r.results) console.log(`  ${x.date} ${x.feed} round ${x.round ?? "?"} ${x.company}: ${x.board ? `${x.board.provider}:${x.board.slug}` : "no verified board"}`);
  } else if (cmd === "targets") {
    const r = targets({ root, dryRun, scan: !process.argv.includes("--no-scan") });
    console.log(`hunt-discover-wide targets: ${r.entries} entries -> ${r.file}; scan ${r.scan ? `exit ${r.scan.status}, ${r.scan.companies} sources, ${r.scan.added} new roles, ${r.scan.errors} errors` : "skipped"}`);
    if (!dryRun && r.scan) spawnSync(process.execPath, [path.join(HERE, "hunt-enrich.mjs"), "--no-fetch", "--quiet"], { cwd: root, env: { ...process.env, CAREER_OPS_ROOT: root }, stdio: "ignore", timeout: 600000 });
  } else {
    console.error("usage: hunt-discover-wide.mjs boards|vc|funding|targets [--dry-run]");
    process.exit(2);
  }
}
