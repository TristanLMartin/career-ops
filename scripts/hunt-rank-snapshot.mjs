#!/usr/bin/env node
// Before/after evidence for ranking changes. Read-only.
//
//   node scripts/hunt-rank-snapshot.mjs save FILE        # Best overall as the dashboard shows it
//   node scripts/hunt-rank-snapshot.mjs diff BEFORE AFTER [--top 20] [--moved 25]
//
// The snapshot applies ratings and liveness the way the dashboard does (applySignals), so it
// matches what the user sees. diff reports the shortlist count, the top-N before and after, jobs
// that moved a lot inside the top 100, and TC estimates that changed by $25k or more.
import fs from "node:fs";
import path from "node:path";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { rankedJobs } from "../web/src/lib/hunt-rank-order.mjs";
import { applySignals } from "../web/src/lib/hunt-job-signals.mjs";

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };

export function snapshot(root = getCareerOpsRoot()) {
  const doc = readJson(path.join(root, "data", "hunt-enrich.json"), { jobs: {} });
  const jobs = applySignals(structuredClone(doc.jobs ?? {}), {
    ratings: readJson(path.join(root, "data", "hunt-ratings.json"), {}),
    liveness: readJson(path.join(root, "data", "hunt-liveness.json"), {}),
  });
  const ranked = rankedJobs(jobs).map((e) => ({ url: e.url, rank: e.rank, company: e.company, role: e.displayRole ?? e.role, fit: e.fit ?? null, tc: e.tc_est?.usd ?? null, tcSource: e.tc_est?.source ?? null }));
  const shortlist = Object.values(jobs).filter((e) => e?.shortlist).length;
  return { at: new Date().toISOString(), generatedAt: doc.generatedAt, shortlist, ranked };
}

const k = (n) => (n == null ? "—" : `$${Math.round(n / 1000)}k`);
const line = (e) => `${String(e.rank).padStart(3)}. ${e.company} · ${e.role}`.slice(0, 78) + `  fit ${e.fit ?? "—"} · TC ${k(e.tc)}`;

export function diff(before, after, { top = 20, moved = 25 } = {}) {
  const out = [];
  const b = new Map(before.ranked.map((e) => [e.url, e]));
  const a = new Map(after.ranked.map((e) => [e.url, e]));
  out.push(`Shortlist: ${before.shortlist} -> ${after.shortlist}. Ranked: ${before.ranked.length} -> ${after.ranked.length}.`);
  const topB = before.ranked.slice(0, top).map((e) => e.url), topA = after.ranked.slice(0, top).map((e) => e.url);
  const entered = topA.filter((u) => !topB.includes(u)), left = topB.filter((u) => !topA.includes(u));
  out.push(`\nTop ${top} after (was):`);
  for (const e of after.ranked.slice(0, top)) out.push(`  ${line(e)}  (was ${b.get(e.url)?.rank ?? "unranked"}${b.get(e.url) && b.get(e.url).tc !== e.tc ? `, TC ${k(b.get(e.url).tc)}` : ""})`);
  out.push(`\nEntered top ${top}: ${entered.length}. Left top ${top}: ${left.length}${left.length ? ` (${left.map((u) => `${b.get(u).company} -> ${a.get(u)?.rank ?? "unranked"}`).join(", ")})` : ""}.`);
  const movers = [...a.values()].filter((e) => b.has(e.url) && (e.rank <= 100 || b.get(e.url).rank <= 100) && Math.abs(e.rank - b.get(e.url).rank) >= moved)
    .sort((x, y) => Math.abs(y.rank - b.get(y.url).rank) - Math.abs(x.rank - b.get(x.url).rank));
  out.push(`\nMoved ${moved}+ places within the top 100: ${movers.length}`);
  for (const e of movers.slice(0, 25)) out.push(`  ${b.get(e.url).rank} -> ${e.rank}  ${e.company} · ${e.role}`.slice(0, 100) + `  TC ${k(b.get(e.url).tc)} -> ${k(e.tc)}`);
  const tcMoves = [...a.values()].filter((e) => b.has(e.url) && e.rank <= 100 && Math.abs((e.tc ?? 0) - (b.get(e.url).tc ?? 0)) >= 25000);
  out.push(`\nTC changed by $25k+ in the top 100: ${tcMoves.length}`);
  for (const e of tcMoves.slice(0, 30)) out.push(`  #${e.rank} ${e.company} · ${e.role}`.slice(0, 80) + `  ${k(b.get(e.url).tc)} -> ${k(e.tc)} (${e.tcSource ?? "none"})`);
  return out.join("\n");
}

if (isMainModule(import.meta.url)) {
  const [cmd, f1, f2] = process.argv.slice(2);
  const num = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
  if (cmd === "save" && f1) { fs.writeFileSync(f1, JSON.stringify(snapshot(), null, 1)); console.log(`saved ${f1}`); }
  else if (cmd === "diff" && f1 && f2) console.log(diff(readJson(f1), readJson(f2), { top: num("--top", 20), moved: num("--moved", 25) }));
  else { console.error("usage: hunt-rank-snapshot.mjs save FILE | diff BEFORE AFTER [--top 20] [--moved 25]"); process.exit(2); }
}
