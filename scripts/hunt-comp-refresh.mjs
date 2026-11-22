#!/usr/bin/env node
// Per-company senior base salary from the US Department of Labor H-1B LCA disclosure data
//. Deterministic, no LLM.
//
// 1. Reads the LCA file list from https://www.dol.gov/agencies/eta/foreign-labor/performance
//    and downloads the latest four quarterly xlsx files into data/lca/ (skipped when present).
//    dol.gov's CDN refuses Node's fetch and custom User-Agents, so downloads use plain curl.
// 2. Streams each sheet (unzip -p), keeps Certified rows for the employers in
//    config/lca-employers.yml with senior software / backend / full-stack / forward
//    deployed / solutions engineer titles, and annualizes WAGE_RATE_OF_PAY_FROM.
// 3. Writes data/comp-lca-summary.json: per company n, median, p25, p75 (home-metro split from lca-employers.yml `home`
//    when n >= 5), plus est. TC = LCA base median x the curated TC/base ratio from
//    config/comp.json.
//
// Usage: node scripts/hunt-comp-refresh.mjs [--no-download] [--quarters 4] [--suggest-employers]
//   --suggest-employers prints EMPLOYER_NAME candidates for pipeline companies with no entry yet.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { loadYaml } from "../lib/yaml-document.mjs";
import { WANTED_COLUMNS, normalizeHome, employerIndex, estimateFromLca, filterRow, isGenericSweTitle, isSeniorSweTitle, normEmployer, parseSharedStrings, sheetRows, summarize } from "../lib/hunt-lca.mjs";
import { normCompany } from "../lib/hunt-comp.mjs";
import { exitOnHelp } from "../lib/cli-guard.mjs";

const PAGE = "https://www.dol.gov/agencies/eta/foreign-labor/performance";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

function curl(url, out) {
  const args = ["-sSfL", "--retry", "2", "-o", out, url];
  const p = spawnSync("curl", args, { encoding: "utf8", timeout: 15 * 60 * 1000 });
  if (p.status !== 0) throw new Error(`curl ${url}: ${(p.stderr || `exit ${p.status}`).trim()}`);
}

/** LCA xlsx links on the DOL performance page, newest first. */
export function lcaLinks(html) {
  const seen = new Set();
  const out = [];
  for (const m of String(html).matchAll(/href="([^"]*LCA_Disclosure_Data_FY(\d{4})_Q(\d)\.xlsx)"/gi)) {
    const url = new URL(m[1], PAGE).href;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, fy: Number(m[2]), q: Number(m[3]), file: `FY${m[2]}_Q${m[3]}.xlsx` });
  }
  return out.sort((a, b) => b.fy - a.fy || b.q - a.q);
}

async function* unzipText(xlsx, member) {
  const p = spawn("unzip", ["-p", xlsx, member]);
  p.stdout.setEncoding("utf8");
  for await (const chunk of p.stdout) yield chunk;
}

export async function rowsOf(xlsx) {
  const shared = parseSharedStrings(spawnSync("unzip", ["-p", xlsx, "xl/sharedStrings.xml"], { encoding: "utf8", maxBuffer: 1 << 30 }).stdout);
  return sheetRows(unzipText(xlsx, "xl/worksheets/sheet1.xml"), shared, WANTED_COLUMNS);
}

export async function refresh({ root = getCareerOpsRoot(), download = true, quarters = 4, suggest = false } = {}) {
  const dir = path.join(root, "data", "lca");
  fs.mkdirSync(dir, { recursive: true });
  let files;
  if (download) {
    const page = path.join(dir, "performance.html");
    curl(PAGE, page);
    const links = lcaLinks(fs.readFileSync(page, "utf8")).slice(0, quarters);
    if (!links.length) throw new Error("no LCA_Disclosure_Data links on the DOL performance page");
    for (const l of links) {
      const out = path.join(dir, l.file);
      if (!fs.existsSync(out) || fs.statSync(out).size < 1e6) curl(l.url, out);
    }
    files = links.map((l) => path.join(dir, l.file));
    // Drop quarters that fell out of the window.
    for (const f of fs.readdirSync(dir)) if (/^FY\d{4}_Q\d\.xlsx$/.test(f) && !links.some((l) => l.file === f)) fs.unlinkSync(path.join(dir, f));
  } else {
    files = fs.readdirSync(dir).filter((f) => /^FY\d{4}_Q\d\.xlsx$/.test(f)).sort().reverse().slice(0, quarters).map((f) => path.join(dir, f));
  }
  const lcaCfg = loadYaml(fs.readFileSync(path.join(root, "config", "lca-employers.yml"), "utf8")) ?? {};
  const employers = lcaCfg.employers ?? {};
  const index = employerIndex(employers);
  const home = normalizeHome(lcaCfg.home);
  const kept = [];
  const candidates = new Map();
  let total = 0;
  for (const f of files) {
    for await (const row of await rowsOf(f)) {
      total++;
      const r = filterRow(row, index, home);
      if (r) kept.push(r);
      else if (suggest && /^certified$/i.test(String(row.CASE_STATUS ?? "")) && (isSeniorSweTitle(row.JOB_TITLE) || isGenericSweTitle(row.JOB_TITLE))) {
        const k = normEmployer(row.EMPLOYER_NAME);
        if (!index.has(k)) candidates.set(row.EMPLOYER_NAME, (candidates.get(row.EMPLOYER_NAME) ?? 0) + 1);
      }
    }
  }
  const summary = summarize(kept);
  let curated = [];
  try { curated = JSON.parse(fs.readFileSync(path.join(root, "config", "comp.json"), "utf8")); } catch {}
  const curatedBy = new Map(curated.map((c) => [normCompany(c.company), c]));
  for (const [company, s] of Object.entries(summary)) s.est = estimateFromLca(s, curatedBy.get(normCompany(company))) ?? null;
  const doc = { generatedAt: new Date().toISOString(), source: "US DOL H-1B LCA disclosure data", files: files.map((f) => path.basename(f)), rowsScanned: total, rowsKept: kept.length, companies: summary };
  fs.writeFileSync(path.join(root, "data", "comp-lca-summary.json"), JSON.stringify(doc, null, 1));
  let suggestions = [];
  if (suggest) {
    let pipelineCompanies = [];
    try { pipelineCompanies = [...new Set(Object.values(JSON.parse(fs.readFileSync(path.join(root, "data", "hunt-enrich.json"), "utf8")).jobs).map((e) => e.company))]; } catch {}
    const byNorm = new Map(pipelineCompanies.map((c) => [normCompany(c), c]).filter(([k]) => k.length >= 3));
    const match = (name) => {
      const k = normCompany(name);
      if (byNorm.has(k)) return byNorm.get(k);
      let best = null;
      for (const [pk, c] of byNorm) if (pk.length >= 4 && k.startsWith(pk) && (!best || pk.length > normCompany(best).length)) best = c;
      return best;
    };
    for (const [name, n] of candidates) {
      const c = match(name);
      if (c && !employers[c]) suggestions.push({ company: c, employer: name, n });
    }
    suggestions.sort((a, b) => a.company.localeCompare(b.company) || b.n - a.n);
  }
  return { doc, suggestions };
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);
  const { doc, suggestions } = await refresh({ download: !process.argv.includes("--no-download"), quarters: Number(arg("--quarters", 4)), suggest: process.argv.includes("--suggest-employers") });
  console.log(`hunt-comp-refresh: ${doc.rowsScanned} LCA rows, ${doc.rowsKept} kept, ${Object.keys(doc.companies).length} companies -> data/comp-lca-summary.json`);
  for (const s of suggestions) console.log(`  suggest ${s.company}: "${s.employer}" (${s.n})`);
}
