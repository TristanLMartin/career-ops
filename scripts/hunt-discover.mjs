#!/usr/bin/env node
// hunt-discover: find companies beyond the 45-company watchlist.
//
// Public, login-free sources only:
//   - Hacker News "Ask HN: Who is hiring?" (Algolia API): the current and previous
//     month. Roles come from career-ops' own hackernews provider (latest thread);
//     both threads are mined for Greenhouse/Lever/Ashby/Workable board links.
//   - Jobs you added by hand (scan-history portal "manual") that sit on one of
//     those boards.
// YC's "Work at a Startup" needs a login and is skipped; no other login-free list
// gives board URLs without guessing, so none is used.
//
// Discovered boards go to data/hunt-discovery.json and two portals files that
// scan.mjs reads through CAREER_OPS_PORTALS, with the same title/location filters
// as portals.yml: data/discovery-boards.yml (every scan) and data/discovery-hn.yml
// (daily). portals.yml's tracked_companies is never touched. Zero AI tokens.
//
// Usage: node scripts/hunt-discover.mjs [--no-fetch] [--scan boards|hn|both]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { loadYaml } from "../lib/yaml-document.mjs";
import { replaceAnchorsWithHref } from "../providers/hackernews.mjs";
import { exitOnHelp } from "../lib/cli-guard.mjs";

const SEARCH = "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10";
const ITEM = (id) => `https://hn.algolia.com/api/v1/items/${id}`;
const UA = "career-ops-hunt-discover/1.0 (personal job search; low volume)";

const BOARD_PATTERNS = [
  { provider: "greenhouse", re: /https?:\/\/(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/gi, url: (s) => `https://job-boards.greenhouse.io/${s}` },
  { provider: "lever", re: /https?:\/\/jobs\.lever\.co\/([a-z0-9_.-]+)/gi, url: (s) => `https://jobs.lever.co/${s}` },
  { provider: "ashby", re: /https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/gi, url: (s) => `https://jobs.ashbyhq.com/${s}` },
  { provider: "workable", re: /https?:\/\/apply\.workable\.com\/([a-z0-9_-]+)/gi, url: (s) => `https://apply.workable.com/${s}/` },
];
const NOT_A_BOARD = new Set(["embed", "jobs", "j", "api", "v1", "careers", "job", "apply"]);

function readText(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

/** Board links in free text -> [{provider, slug, careers_url}] (deduped). */
export function boardsInText(text) {
  const out = new Map();
  const s = replaceAnchorsWithHref(String(text ?? "")).replace(/&#x2F;/g, "/").replace(/&amp;/g, "&");
  for (const p of BOARD_PATTERNS) {
    for (const m of s.matchAll(p.re)) {
      const slug = decodeURIComponent(m[1]).toLowerCase().replace(/[.,;)]+$/, "");
      if (!slug || NOT_A_BOARD.has(slug)) continue;
      out.set(`${p.provider}:${slug}`, { provider: p.provider, slug, careers_url: p.url(slug) });
    }
  }
  return [...out.values()];
}

/** "Acme (YC W24) | Senior Backend | Remote" -> "Acme". */
export function hnCompany(text) {
  const first = replaceAnchorsWithHref(String(text ?? "")).split(/<p>|\n/)[0].replace(/<[^>]+>/g, "");
  const name = first.split("|")[0].replace(/\(.*?\)/g, "").replace(/https?:\/\/\S+/g, "").trim();
  return name && name.length <= 60 ? name : null;
}

/** Slugs already watched in portals.yml (careers_url / api), so they're not "discovered". */
export function watchedSlugs(portalsText) {
  const set = new Set();
  for (const b of boardsInText(portalsText)) set.add(`${b.provider}:${b.slug}`);
  for (const m of String(portalsText).matchAll(/boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/gi)) set.add(`greenhouse:${m[1].toLowerCase()}`);
  return set;
}

export function watchedNames(portalsText) {
  return new Set([...String(portalsText).matchAll(/^\s*-\s*name:\s*(.+)$/gm)].map((m) => m[1].trim().replace(/^["']|["']$/g, "").toLowerCase()));
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** The latest two "Who is hiring?" threads -> {threads, boards}. */
export async function harvestHn(fetchJson = getJson) {
  const search = await fetchJson(SEARCH);
  const stories = (search?.hits ?? []).filter((h) => /who is hiring/i.test(h.title ?? "")).slice(0, 2);
  const boards = new Map();
  const threads = [];
  for (const st of stories) {
    const item = await fetchJson(ITEM(st.objectID));
    const kids = Array.isArray(item?.children) ? item.children : [];
    threads.push({ id: st.objectID, title: st.title, comments: kids.length });
    for (const c of kids) {
      if (!c || c.deleted || c.dead || typeof c.text !== "string") continue;
      const company = hnCompany(c.text);
      for (const b of boardsInText(c.text)) {
        const k = `${b.provider}:${b.slug}`;
        if (!boards.has(k)) boards.set(k, { ...b, name: company ?? b.slug, source: `hn:${st.objectID}` });
      }
    }
  }
  return { threads, boards: [...boards.values()] };
}

function filterConfig(portals) {
  const keep = {};
  for (const k of Object.keys(portals ?? {})) if (k !== "tracked_companies" && k !== "search_queries") keep[k] = portals[k];
  // Discovery fails closed: a posting with no stated location is dropped, not "anywhere".
  if (keep.location_filter) keep.location_filter = { ...keep.location_filter, strict: true };
  return keep;
}

function yamlDump(obj) {
  // Minimal, safe YAML (JSON is valid YAML) so no js-yaml dump dependency is needed.
  return `# Generated by scripts/hunt-discover.mjs. Do not edit; edit portals.yml filters instead.\n${JSON.stringify(obj, null, 1)}\n`;
}

export async function discover({ root = getCareerOpsRoot(), fetchHn = true, fetchJson = getJson, now = new Date() } = {}) {
  const portalsText = readText(path.join(root, "portals.yml"));
  const portals = loadYaml(portalsText) ?? {};
  const watched = watchedSlugs(portalsText);
  const names = watchedNames(portalsText);
  const stateFile = path.join(root, "data", "hunt-discovery.json");
  let state = { boards: [], threads: [] };
  try { state = JSON.parse(readText(stateFile)) || state; } catch {}
  const known = new Map((state.boards ?? []).map((b) => [`${b.provider}:${b.slug}`, b]));

  if (fetchHn) {
    const hn = await harvestHn(fetchJson);
    state.threads = hn.threads;
    for (const b of hn.boards) {
      const k = `${b.provider}:${b.slug}`;
      if (!known.has(k)) known.set(k, { ...b, firstSeen: now.toISOString().slice(0, 10) });
    }
  }
  // Boards behind jobs added by hand.
  const hist = readText(path.join(root, "data", "scan-history.tsv")).split("\n");
  const h = (hist[0] ?? "").split("\t");
  for (const line of hist.slice(1)) {
    const c = line.split("\t");
    if (c[h.indexOf("portal")] !== "manual") continue;
    for (const b of boardsInText(c[h.indexOf("url")] ?? "")) {
      const k = `${b.provider}:${b.slug}`;
      if (!known.has(k)) known.set(k, { ...b, name: c[h.indexOf("company")] || b.slug, source: "manual", firstSeen: now.toISOString().slice(0, 10) });
    }
  }
  const boards = [...known.values()].filter((b) => !watched.has(`${b.provider}:${b.slug}`) && !names.has(String(b.name).toLowerCase()));
  state.boards = boards;
  state.updatedAt = now.toISOString();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));

  const filters = filterConfig(portals);
  const entry = (b) => ({ name: b.name, careers_url: b.careers_url, ...(b.provider === "greenhouse" ? { api: `https://boards-api.greenhouse.io/v1/boards/${b.slug}/jobs` } : {}), enabled: true });
  fs.writeFileSync(path.join(root, "data", "discovery-boards.yml"), yamlDump({ ...filters, tracked_companies: boards.map(entry) }));
  fs.writeFileSync(path.join(root, "data", "discovery-hn.yml"), yamlDump({ ...filters, tracked_companies: [{ name: "Hacker News Who is hiring", provider: "hackernews", enabled: true }] }));
  return { boards: boards.length, threads: state.threads };
}

export function runDiscoveryScan(root, which) {
  const file = path.join(root, "data", which === "hn" ? "discovery-hn.yml" : which === "vc" ? "discovery-vc.yml" : which === "targets" ? "discovery-targets.yml" : "discovery-boards.yml");
  if (!fs.existsSync(file)) return { status: 0, out: "no discovery portals yet" };
  const p = spawnSync(process.execPath, ["scan.mjs"], { cwd: path.dirname(new URL(import.meta.url).pathname) + "/..", env: { ...process.env, CAREER_OPS_PORTALS: file, CAREER_OPS_ROOT: root }, encoding: "utf8", timeout: 1800000 });
  const added = (p.stdout ?? "").match(/New offers added:\s+(\d+)/)?.[1] ?? "0";
  const companies = (p.stdout ?? "").match(/Companies scanned:\s+(\d+)/)?.[1] ?? "?";
  return { status: p.status, added: Number(added), companies, errors: (p.stdout ?? "").match(/Errors \((\d+)\)/)?.[1] ?? "0" };
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);
  const noFetch = process.argv.includes("--no-fetch");
  const i = process.argv.indexOf("--scan");
  const which = i > 0 ? process.argv[i + 1] : null;
  const root = getCareerOpsRoot();
  const r = await discover({ root, fetchHn: !noFetch });
  console.log(`hunt-discover: ${r.boards} discovered boards; HN threads: ${r.threads.map((t) => `${t.title} (${t.comments})`).join("; ") || "none"}`);
  for (const w of which === "both" ? ["hn", "boards"] : which ? [which] : []) {
    const s = runDiscoveryScan(root, w);
    console.log(`  scan ${w}: exit ${s.status}, ${s.companies} sources, ${s.added} new roles, ${s.errors} errors`);
  }
}
