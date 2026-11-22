#!/usr/bin/env node
// hunt-add-job: add a job you found yourself, by URL, without duplicates.
//
// 1. Duplicate check, reusing career-ops' own matchers (precheck-duplicate.mjs:
//    same posting URL via url-key.mjs, same company + title, similar title) against
//    the tracker, the pipeline inbox and scan history, plus our duplicate groups
//    (company + base title, lib/hunt-rank.mjs groupKey).
// 2. Title and JD from the ATS public API (browser-extract.mjs fetchJdViaKnownApi,
//    the same dispatch fetch-jd.mjs uses). Company from portals.yml or the URL.
//    A URL nothing can read (LinkedIn, most custom career sites) needs company +
//    title from the caller (optional pasted JD text).
// 3. Append through scan.mjs's canonical writers (appendToPipeline +
//    appendToScanHistory) with source "manual", keep the JD for hunt-enrich,
//    and re-enrich so pay, level and relevance show up at once.
// Zero AI tokens. Never applies or sends anything. Posting content is untrusted data.
//
// Usage: echo '{"url":"https://...","company":"","title":"","location":"","jd":""}' \
//          | node scripts/hunt-add-job.mjs [--force] [--no-enrich]
//   prints one JSON object: {status: "duplicate"|"added"|"need-details"|"error", ...}
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getCareerOpsRoot, resolveTrackerPath } from "../path-resolver.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { normalizeUrl, canonicalJobKey } from "../url-key.mjs";
import { findDuplicateCandidates, loadTrackerRows } from "../precheck-duplicate.mjs";
import { groupKey } from "../lib/hunt-rank.mjs";
import { localToday } from "../lib/local-today.mjs";
import { loadYaml } from "../lib/yaml-document.mjs";
import { exitOnHelp } from "../lib/cli-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANUAL_JD = (root) => path.join(root, "data", "cache", "hunt-jd", "manual.json");

function readText(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

function keyOf(url) {
  try { return canonicalJobKey(url) || normalizeUrl(url); } catch { return normalizeUrl(url); }
}

/** Pending + processed rows of data/pipeline.md as tracker-shaped rows for findDuplicateCandidates. */
export function pipelineRows(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/^- \[([ x!])\] (.+)$/);
    if (!m) continue;
    const parts = m[2].split(" | ").map((s) => s.trim());
    if (!/^https?:\/\//.test(parts[0] ?? "")) continue;
    rows.push({ num: "inbox", url: parts[0], company: parts[1] ?? "", role: parts[2] ?? "", status: m[1] === "x" ? "Processed" : "Inbox", date: "", notes: "" });
  }
  return rows;
}

export function scanHistoryRows(tsv) {
  const lines = String(tsv).split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const h = lines[0].split("\t");
  const ix = (k) => h.indexOf(k);
  return lines.slice(1).map((l) => l.split("\t")).map((c) => ({ num: "history", url: c[ix("url")] ?? "", company: c[ix("company")] ?? "", role: c[ix("title")] ?? "", status: c[ix("status")] ?? "", date: c[ix("first_seen")] ?? "", notes: "" }));
}

/** Company name for a known ATS URL, from portals.yml tracked_companies, else the URL slug. */
export function companyFromUrl(url, portalsText = "") {
  const u = String(url);
  const slug = u.match(/greenhouse\.io\/(?:embed\/job_board\?for=)?([^/?#]+)/)?.[1]
    ?? u.match(/jobs\.ashbyhq\.com\/([^/?#]+)/)?.[1]
    ?? u.match(/jobs\.lever\.co\/([^/?#]+)/)?.[1]
    ?? u.match(/https?:\/\/([^.]+)\.wd\d+\.myworkdayjobs\.com/)?.[1]
    ?? null;
  const entries = [...String(portalsText).matchAll(/-\s*name:\s*(.+)\n((?:\s{4,}.+\n?)*)/g)].map((m) => ({ name: m[1].trim().replace(/^["']|["']$/g, ""), body: m[2] }));
  if (slug) {
    const hit = entries.find((e) => e.body.toLowerCase().includes(`/${slug.toLowerCase()}`) || e.name.toLowerCase().replace(/[^a-z0-9]/g, "") === slug.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (hit) return hit.name;
  }
  let host = "";
  try { host = new URL(u).hostname.replace(/^www\./, ""); } catch {}
  const hostHit = host && entries.find((e) => e.body.includes(host));
  if (hostHit) return hostHit.name;
  if (slug) return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return null;
}

/**
 * @param {{url: string, company?: string, title?: string, location?: string, jd?: string}} input
 * @param {{root?: string, force?: boolean, enrich?: boolean, fetchJd?: (url: string) => Promise<{title: string, text: string, ats: string}|null>, today?: string}} [opts]
 */
export async function addJob(input, opts = {}) {
  const root = opts.root ?? getCareerOpsRoot();
  const url = String(input?.url ?? "").trim();
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return { status: "error", message: "Paste a full job URL starting with https://" };
  const key = keyOf(url);
  const tracker = loadTrackerRows(resolveTrackerPath(root)) ?? [];
  const inbox = pipelineRows(readText(path.join(root, "data", "pipeline.md")));
  const history = scanHistoryRows(readText(path.join(root, "data", "scan-history.tsv")));

  // 1a. Same posting URL anywhere.
  const sameUrl = (rows) => rows.find((r) => r.url && (r.url === url || keyOf(r.url) === key));
  const urlHit = sameUrl(tracker) ?? sameUrl(inbox) ?? sameUrl(history.filter((h) => h.status === "added"));
  if (urlHit && !opts.force) return { status: "duplicate", reason: "same posting URL", match: describe(urlHit) };

  // 2. Company, title and JD.
  let company = String(input.company ?? "").trim();
  let title = String(input.title ?? "").trim();
  let jd = String(input.jd ?? "").trim();
  let ats = "manual";
  if (!title || !jd) {
    let fetched = null;
    try { fetched = await (opts.fetchJd ?? defaultFetchJd)(url); } catch { fetched = null; }
    if (fetched?.text) { jd = jd || fetched.text; title = title || String(fetched.title ?? "").trim(); ats = fetched.ats || ats; }
  }
  if (!company) company = companyFromUrl(url, readText(path.join(root, "portals.yml"))) ?? "";
  if (!company || !title) {
    return { status: "need-details", message: /linkedin\.com/i.test(url) ? "LinkedIn doesn't share job details with tools. Add the company and title (and paste the description if you have it)." : "Couldn't read this posting. Add the company and title (and paste the description if you have it).", known: { company, title } };
  }

  // 1b. Same company + title in the tracker, inbox or history (career-ops' matcher), then our groups.
  if (!opts.force) {
    const candidates = findDuplicateCandidates([...tracker, ...inbox, ...history.filter((h) => h.status === "added")], { company, title, url });
    const strong = candidates.find((c) => c.reason === "same-title" || c.reason === "url");
    if (strong) return { status: "duplicate", reason: strong.detail, match: strong };
    const g = groupKey(company, title);
    let enrichJobs = {};
    try { enrichJobs = JSON.parse(readText(path.join(root, "data", "hunt-enrich.json"))).jobs ?? {}; } catch {}
    const sameGroup = Object.entries(enrichJobs).find(([, e]) => e.group === g);
    if (sameGroup) return { status: "duplicate", reason: "same company and base title (a similar posting)", similar: true, match: { url: sameGroup[0], company: sameGroup[1].company, role: sameGroup[1].role, status: sameGroup[1].status ?? (sameGroup[1].source === "inbox" ? "Inbox" : "") } };
  }
  const filtered = history.find((h) => h.url && keyOf(h.url) === key && h.status !== "added");

  // 3. Write through the core's writers.
  const location = String(input.location ?? "").trim();
  const source = /^[a-z0-9-]{1,40}$/.test(String(opts.source ?? "")) ? opts.source : "manual";
  const scan = await import("../scan.mjs");
  // Discovery finds (Dice, Indeed, YC, VC boards...) obey portals.yml's location_filter like
  // a scan does, and need a stated location: an empty one would otherwise pass as "anywhere".
  if (/^discovery/.test(source) && !opts.force) {
    let portals = {};
    try { portals = loadYaml(readText(path.join(root, "portals.yml"))) ?? {}; } catch {}
    const locationOk = portals.location_filter ? scan.buildLocationFilter(portals.location_filter) : () => true;
    if (!location || !locationOk(location, url)) {
      await scan.appendToScanHistory([{ url, company, title, location, source }], opts.today ?? localToday(), "skipped_location", { historyPath: path.join(root, "data", "scan-history.tsv") });
      return { status: "filtered", reason: location ? `location "${location}" is outside portals.yml location_filter` : "no location stated" };
    }
  }
  const offer = { url, company, title, location, source, note: source === "manual" ? "added by hand" : `found via ${source}` };
  await scan.appendToPipeline([offer], { pipelinePath: path.join(root, "data", "pipeline.md"), scanHistoryPath: path.join(root, "data", "scan-history.tsv") });
  await scan.appendToScanHistory([offer], opts.today ?? localToday(), "added", { historyPath: path.join(root, "data", "scan-history.tsv") });
  if (jd) {
    const file = MANUAL_JD(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let cache = { texts: {} };
    try { cache = JSON.parse(readText(file)) || cache; } catch {}
    cache.texts = { ...(cache.texts ?? {}), [url]: jd.slice(0, 60000) };
    cache.fetchedAt = Date.now();
    fs.writeFileSync(file, JSON.stringify(cache));
  }
  let enrichment = null;
  if (opts.enrich !== false) {
    spawnSync(process.execPath, [path.join(HERE, "hunt-enrich.mjs"), "--no-fetch", "--quiet"], { cwd: root, env: { ...process.env, CAREER_OPS_ROOT: root }, stdio: "ignore", timeout: 120000 });
    try { enrichment = JSON.parse(readText(path.join(root, "data", "hunt-enrich.json"))).jobs?.[url] ?? null; } catch {}
  }
  return { status: "added", job: { url, company, title, location, ats, hasDescription: !!jd }, enrichment, note: filtered ? `The scanner had seen this posting and filtered it out (${filtered.status}); it's added now because you asked.` : undefined };
}

function describe(r) {
  return { num: r.num, company: r.company, role: r.role, status: r.status, url: r.url, date: r.date };
}

async function defaultFetchJd(url) {
  const { fetchJdViaKnownApi } = await import("../browser-extract.mjs");
  return fetchJdViaKnownApi(url);
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch { console.log(JSON.stringify({ status: "error", message: "bad JSON input" })); process.exit(1); }
  const out = await addJob(input, { force: process.argv.includes("--force"), enrich: !process.argv.includes("--no-enrich") });
  console.log(JSON.stringify(out));
}
