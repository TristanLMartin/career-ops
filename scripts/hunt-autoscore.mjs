#!/usr/bin/env node
// hunt-autoscore: score the strongest unscored postings through career-ops'
// normal evaluate flow (the running web UI's /api/run), so Top picks stays fresh.
//
// Picks: unscored inbox postings by composite rank that are on target (config/ranking.yml
// `target`: level keys, location tiers, always_companies), at most N per company. Each is evaluated on the web's spend tier (Haiku, spend_tier: economy).
// A run that fails on the report format is retried once on Sonnet through a
// temporary loopback-only server. Every run is logged to data/hunt-usage.tsv.
// Never applies, submits or sends anything.
//
// Usage: node scripts/hunt-autoscore.mjs [--count N] [--per-company N] [--parallel 1-4] [--dry-run] [--urls u1,u2,...]
//   --urls scores exactly those postings (any level/location) instead of the automatic picks.
//   --count defaults to auto_score_per_day in config/ranking.yml.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { loadYaml } from "../lib/yaml-document.mjs";

import { normalizeTarget, onTarget } from "../lib/hunt-rank.mjs";
import { exitOnHelp, requireSpendConsent } from "../lib/cli-guard.mjs";
// Each profile's web instance has its own port (CAREER_OPS_WEB_PORT, default 3000), and its
// Sonnet retry server sits 8 above it.
const WEB_PORT = Number(process.env.CAREER_OPS_WEB_PORT) || 3000;
const UI = process.env.HUNT_UI_URL ?? `http://127.0.0.1:${WEB_PORT}`;
const SONNET_PORT = WEB_PORT + 8;
const CODE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const FORMAT_FAILURE = /envelope was never closed|both a report and a confirmation stop|didn't produce a report|did not produce a report/i;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

export function pickCandidates(enrichJobs, { count = 5, perCompany = 2, exclude = new Set(), target = null } = {}) {
  if (!(count > 0)) return []; // auto_score_per_day: 0 means none (a new profile spends nothing)
  const t = normalizeTarget(target);
  const per = new Map();
  const out = [];
  const ranked = Object.entries(enrichJobs)
    .filter(([url, e]) => !exclude.has(url) && e.source === "inbox" && e.fit == null && typeof e.composite === "number")
    .filter(([, e]) => onTarget(e, t) && !e.contract && !e.belowFloor)
    .sort((a, b) => b[1].composite - a[1].composite);
  for (const [url, e] of ranked) {
    const n = per.get(e.company) ?? 0;
    if (n >= perCompany) continue;
    per.set(e.company, n + 1);
    out.push({ url, company: e.company, role: e.displayRole ?? e.role, composite: e.composite, level: e.level?.label });
    if (out.length >= count) break;
  }
  return out;
}

async function evaluate(base, url) {
  const started = Date.now();
  const res = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "evaluate", input: url, cliId: "claude" }),
    signal: AbortSignal.timeout(25 * 60 * 1000),
  });
  const text = await res.text();
  let last = null;
  for (const line of text.split("\n")) {
    try { const o = JSON.parse(line); if (o.type === "done" || o.type === "error") last = o; else if (o.type === "gated") last = { type: "error", msg: `gated: ${o.reason}: ${String(o.message ?? "").slice(0, 80)}`, tokens: o.tokens, costUsd: o.costUsd }; } catch {}
  }
  return { secs: Math.round((Date.now() - started) / 1000), last, httpStatus: res.status };
}

async function withSonnetServer(root, fn) {
  const child = spawn("npm", ["start", "--", "-p", String(SONNET_PORT)], {
    cwd: path.join(CODE_ROOT, "web"), // the code checkout; CAREER_OPS_PROFILE_DIR (inherited) picks the data
    env: { ...process.env, ANTHROPIC_MODEL: "claude-sonnet-5-5", CAREER_OPS_WEB_ALLOWED_HOSTS: "" },
    stdio: "ignore",
    detached: true,
  });
  try {
    const base = `http://127.0.0.1:${SONNET_PORT}`;
    for (let i = 0; i < 60; i++) {
      try { await fetch(base, { signal: AbortSignal.timeout(1000) }); break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    return await fn(base);
  } finally {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
}

function logUsage(root, row) {
  const file = path.join(root, "data", "hunt-usage.tsv");
  if (!fs.existsSync(file)) fs.writeFileSync(file, "date\tmodel\tstatus\tsecs\ttokens\tcost_usd\treport\tcompany\trole\turl\n");
  const clean = (v) => String(v ?? "").replace(/[\t\n]/g, " ");
  fs.appendFileSync(file, [row.date, row.model, row.status, row.secs, row.tokens, row.cost, row.report, row.company, row.role, row.url].map(clean).join("\t") + "\n");
}

export async function autoscore({ root = getCareerOpsRoot(), count, perCompany = 2, parallel = 1, dryRun = false, urls = null } = {}) {
  let cfg = {};
  try { cfg = loadYaml(fs.readFileSync(path.join(root, "config", "ranking.yml"), "utf8")) ?? {}; } catch {}
  const n = Number(count ?? cfg.auto_score_per_day ?? 0);
  const enrich = JSON.parse(fs.readFileSync(path.join(root, "data", "hunt-enrich.json"), "utf8"));
  const picks = urls?.length
    ? urls.map((url) => { const e = enrich.jobs[url] ?? {}; return { url, company: e.company ?? "", role: e.displayRole ?? e.role ?? "", composite: e.composite ?? null, level: e.level?.label }; })
    : pickCandidates(enrich.jobs, { count: n, perCompany, target: cfg.target });
  if (dryRun || picks.length === 0) return { picks, results: [] };
  const results = [];
  const retry = [];
  const one = async (p) => {
    const r = await evaluate(UI, p.url).catch((e) => ({ secs: 0, last: { type: "error", msg: String(e?.message ?? e) }, httpStatus: 0 }));
    const ok = r.last?.type === "done";
    logUsage(root, { date: new Date().toISOString(), model: "spend_tier", status: ok ? "ok" : `error: ${(r.last?.msg ?? `HTTP ${r.httpStatus}`).slice(0, 100)}`, secs: r.secs, tokens: r.last?.tokens ?? "", cost: r.last?.costUsd ?? "", report: r.last?.reportN ?? "", ...p });
    results.push({ ...p, ok, secs: r.secs, msg: r.last?.msg });
    if (!ok && FORMAT_FAILURE.test(r.last?.msg ?? "")) retry.push(p);
  };
  // Worker pool: a slow evaluation no longer holds up the other slots.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, picks.length) }, async () => { while (next < picks.length) await one(picks[next++]); }));
  if (retry.length) {
    await withSonnetServer(root, async (base) => {
      let ri = 0;
      await Promise.all(Array.from({ length: Math.min(parallel, retry.length) }, async () => { while (ri < retry.length) { const p = retry[ri++];
        const r = await evaluate(base, p.url);
        const ok = r.last?.type === "done";
        logUsage(root, { date: new Date().toISOString(), model: "claude-sonnet-5-5 (retry)", status: ok ? "ok" : `error: ${(r.last?.msg ?? `HTTP ${r.httpStatus}`).slice(0, 100)}`, secs: r.secs, tokens: r.last?.tokens ?? "", cost: r.last?.costUsd ?? "", report: r.last?.reportN ?? "", ...p });
        results.push({ ...p, ok, retried: true, secs: r.secs, msg: r.last?.msg });
      } }));
    });
  }
  return { picks, results };
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);
  requireSpendConsent("hunt-autoscore", { freeFlags: ["--dry-run"] });
  const count = arg("--count", undefined);
  const perCompany = Number(arg("--per-company", 2));
  const dryRun = process.argv.includes("--dry-run");
  const parallel = Math.max(1, Math.min(4, Number(arg("--parallel", 1))));
  const urls = arg("--urls", "")?.split(",").map((u) => u.trim()).filter(Boolean);
  const { picks, results } = await autoscore({ count, perCompany, parallel, dryRun, urls });
  if (dryRun) for (const p of picks) console.log(`${p.composite}\t${p.level}\t${p.company}\t${p.role}`);
  const ok = results.filter((r) => r.ok).length;
  console.log(`hunt-autoscore: ${picks.length} picked${dryRun ? " (dry run)" : `, ${ok} scored, ${results.filter((r) => !r.ok).length} failed`}`);
}
