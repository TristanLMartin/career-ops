#!/usr/bin/env node
// hunt: posting liveness for Best overall (data/hunt-liveness.json). Posting age alone no
// longer demotes a job; a job drops out of Best overall only when its URL answers closed
// (404, "no longer accepting", gone from the ATS board API). This checks the top of Best overall
// (default 50) plus every ranked job posted over 180 days ago (in the top 400), with
// check-liveness.mjs --no-fallback --no-record: public ATS APIs first, then one headless page
// load (robots.txt respected, no headed retry). Zero model tokens.
//
//   node scripts/hunt-liveness.mjs [--top=50] [--max-age-scan=400] [--dry-run] [url ...]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applySignals } from "../web/src/lib/hunt-job-signals.mjs";
import { rankedJobs } from "../web/src/lib/hunt-rank-order.mjs";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { exitOnHelp } from "../lib/cli-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // code (check-liveness.mjs)
const DATA = path.join(getCareerOpsRoot(), "data"); // this profile's data (CAREER_OPS_PROFILE_DIR)
const OUT = path.join(DATA, "hunt-liveness.json");
const arg = (k, d) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d);
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

/** URLs to check: the top `top` of Best overall plus anything ranked in the first `scan` posted >180 days ago. */
export function livenessTargets(ranked, { top = 50, scan = 400 } = {}) {
  const out = new Set(ranked.slice(0, top).map((e) => e.url));
  for (const e of ranked.slice(0, scan)) if (Number.isFinite(e.postedDays) && e.postedDays > 180) out.add(e.url);
  return [...out];
}

/** check-liveness.mjs output lines -> {url: {verdict, reason?}}. */
export function parseLivenessOutput(text) {
  const out = {};
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\S+\s+(active|expired|uncertain)\s+(?:\(api\)\s+)?.*?(https?:\/\/\S+)\s*$/);
    if (!m) continue;
    const reason = m[1] !== "active" && /^\s{6,}\S/.test(lines[i + 1] ?? "") ? lines[i + 1].trim().slice(0, 200) : undefined;
    out[m[2]] = { verdict: m[1], ...(reason ? { reason } : {}) };
  }
  return out;
}

async function main() {
  const extra = process.argv.slice(2).filter((a) => /^https?:\/\//.test(a));
  const doc = read(path.join(DATA, "hunt-enrich.json"), { jobs: {} });
  const prev = read(OUT, { checks: {} });
  const jobs = applySignals(doc.jobs ?? {}, { ratings: read(path.join(DATA, "hunt-ratings.json"), {})?.ratings ?? {}, liveness: {} });
  const urls = [...new Set([...livenessTargets(rankedJobs(jobs), { top: arg("top", 50), scan: arg("max-age-scan", 400) }), ...extra])];
  if (process.argv.includes("--dry-run")) { console.log(urls.join("\n")); return; }
  const list = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tl-")), "urls.txt");
  fs.writeFileSync(list, urls.join("\n") + "\n");
  let text = "";
  try {
    text = execFileSync("node", ["check-liveness.mjs", "--no-fallback", "--no-record", "--file", list], { cwd: root, encoding: "utf8", maxBuffer: 32 << 20, timeout: 45 * 60_000 });
  } catch (e) {
    text = String(e.stdout ?? ""); // exit 1 = some expired or uncertain; the output is still complete
  }
  const at = new Date().toISOString().slice(0, 10);
  const found = parseLivenessOutput(text);
  const checks = { ...(prev.checks ?? {}) };
  for (const [url, v] of Object.entries(found)) {
    // An uncertain answer never overwrites a confirmed one from an earlier run.
    if (v.verdict === "uncertain" && checks[url] && checks[url].verdict !== "uncertain") continue;
    checks[url] = { ...v, at };
  }
  fs.writeFileSync(OUT, JSON.stringify({ source: "scripts/hunt-liveness.mjs (check-liveness.mjs --no-fallback --no-record): top of Best overall + postings over 180 days", at, checks }, null, 1));
  const n = (k) => Object.values(found).filter((v) => v.verdict === k).length;
  console.log(`hunt-liveness: ${urls.length} checked, ${n("active")} active, ${n("expired")} expired, ${n("uncertain")} uncertain`);
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);
  await main();
}
