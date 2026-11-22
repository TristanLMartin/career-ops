#!/usr/bin/env node
// hunt-autoscore: score the strongest unscored postings through career-ops'
// normal evaluate flow (the running web UI's /api/run), so Top picks stays fresh.
//
// Picks: unscored inbox postings by composite rank that pass the profile's filters
// (config/ranking.yml `target`, see scripts/hunt-job-filters.mjs), or the profile's own
// `auto_score_picker`, at most N per company. Each is evaluated (lite scope) on the web's spend
// tier (config/profile.yml spend_tier, or ranking.yml auto_score_model).
// A run that fails on the report format is retried once on Sonnet through a
// temporary loopback-only server. Every run is logged to data/hunt-usage.tsv.
// Never applies, submits or sends anything.
//
// Usage: node scripts/hunt-autoscore.mjs [--count N] [--per-company N] [--parallel 1-4] [--dry-run] [--urls u1,u2,...]
//   --urls scores exactly those postings (any level/location) instead of the automatic picks.
//   --count defaults to auto_score_per_day in config/ranking.yml.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { loadYaml } from "../lib/yaml-document.mjs";

import { filterJob } from "./hunt-job-filters.mjs";
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

const CONTRACT_TITLE = /\bcontract(or|-to-hire)?\b|\b\d+\s*[-–]?\s*(\d+\s*)?months?\b|\btemp(orary)?\b|\bfreelance\b/i;
const words = (list) => (Array.isArray(list) ? list : []).map((w) => String(w).trim()).filter(Boolean);
const anyWord = (list) => {
  const w = words(list);
  return w.length ? new RegExp(`\\b(${w.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")).join("|")})\\b`, "i") : null;
};

/**
 * A profile's own picker (config/ranking.yml `auto_score_picker`), for a person whose
 * search is better described by title words than by level keys: title words, its own location
 * tiers, no always-companies,
 * contract roles kept but ranked lower, and coordinator / RPO-agency roles skipped unless their
 * quick score is 5.
 * @param {Record<string, any>} enrichJobs
 * @param {{ title_include?: string[], exclude_titles?: string[], exclude_companies?: string[], exclude_unless_quick?: number, location_tiers?: number[], contract_factor?: number }} cfg
 */
export function pickWithProfile(enrichJobs, cfg, { count = 5, perCompany = 2, exclude = new Set() } = {}) {
  if (!(count > 0)) return [];
  const include = anyWord(cfg.title_include);
  const offTitle = anyWord(cfg.exclude_titles);
  const offCompany = anyWord(cfg.exclude_companies);
  const unless = Number.isFinite(Number(cfg.exclude_unless_quick)) ? Number(cfg.exclude_unless_quick) : 5;
  const tiers = new Set((cfg.location_tiers ?? [1, 2]).map(Number));
  const contractFactor = Number.isFinite(Number(cfg.contract_factor)) ? Number(cfg.contract_factor) : 0.9;
  const per = new Map();
  const out = [];
  const ranked = Object.entries(enrichJobs)
    .filter(([url, e]) => !exclude.has(url) && e.source === "inbox" && e.fit == null && typeof e.composite === "number" && e.groupLeader !== false)
    .map(([url, e]) => {
      const title = String(e.displayRole ?? e.role ?? "");
      const contract = !!e.contract || CONTRACT_TITLE.test(title);
      return { url, e, title, contract, rank: e.composite * (contract ? contractFactor : 1) };
    })
    .filter(({ title }) => !include || include.test(title))
    .filter(({ e }) => tiers.has(e.locationTier))
    .filter(({ e, title }) => {
      const off = (offTitle && offTitle.test(title)) || (offCompany && offCompany.test(`${e.company ?? ""} ${title}`));
      return !off || e.quick_score === unless;
    })
    .sort((a, b) => b.rank - a.rank);
  for (const { url, e, title, contract, rank } of ranked) {
    const n = per.get(e.company) ?? 0;
    if (n >= perCompany) continue;
    per.set(e.company, n + 1);
    out.push({ url, company: e.company, role: title, composite: e.composite, rank: Math.round(rank * 10) / 10, contract, quick: e.quick_score ?? null, level: e.level?.label });
    if (out.length >= count) break;
  }
  return out;
}

export function pickCandidates(enrichJobs, { count = 5, perCompany = 2, exclude = new Set(), picker = null, target = null } = {}) {
  if (!(count > 0)) return []; // auto_score_per_day: 0 means none (a new profile spends nothing)
  // A profile with its own picker config uses it; otherwise the target filters below.
  if (picker && typeof picker === "object") return pickWithProfile(enrichJobs, picker, { count, perCompany: Number(picker.per_company ?? perCompany), exclude });
  // One filter set (scripts/hunt-job-filters.mjs) for autoscore and bulk picks.
  const per = new Map();
  const out = [];
  const ranked = Object.entries(enrichJobs)
    .filter(([url, e]) => !exclude.has(url) && e.source === "inbox" && e.fit == null && typeof e.composite === "number")
    .filter(([, e]) => filterJob(e, target).ok)
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

// hunt: automatic and bulk runs use the lite scope (modes/oferta-lite.md: score + level fit);
// the job page's Deep dive runs the full evaluation. noUsageLog: this script logs its own rows.
export async function evaluate(base, url, { scope = "lite" } = {}) {
  const started = Date.now();
  const res = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "evaluate", input: url, cliId: "claude", noUsageLog: true, ...(scope && scope !== "full" ? { evaluationScope: scope } : {}) }),
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
  return withModelServer("claude-sonnet-5-5", SONNET_PORT, fn);
}

/** A temporary loopback-only web server whose runs use `model` (ANTHROPIC_MODEL wins over spend_tier). */
export async function withModelServer(model, port, fn) {
  // a server already on this port (left by a killed run) would serve the wrong model or none
  const busy = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
  if (busy) {
    // a temporary server left by a killed (kill -9) run of these scripts: stop it, then start ours
    // the listener is next-server; stop its whole group when the group leader is our `npm start -p <port>`
    try {
      const pid = String(execFileSync("ss", ["-ltnpH", `sport = :${port}`])).match(/pid=(\d+)/)?.[1];
      const pgid = pid && String(execFileSync("ps", ["-o", "pgid=", "-p", pid])).trim();
      let leader = null; try { leader = pgid && fs.readFileSync(`/proc/${pgid}/cmdline`, "utf8").split("\0").join(" "); } catch {}
      if (leader && /\bnpm\b.*\bstart\b.*-p \d+/.test(leader) && leader.includes(`-p ${port}`)) process.kill(-Number(pgid), "SIGTERM");
      // leader already gone: an orphaned next-server running from this checkout's web/
      else if (!leader && fs.realpathSync(`/proc/${pid}/cwd`) === fs.realpathSync(path.join(CODE_ROOT, "web"))) process.kill(-Number(pgid), "SIGTERM");
    } catch {}
    await new Promise((r) => setTimeout(r, 4000));
    const still = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
    if (still) throw new Error(`port ${port} is already in use by something else; stop it first`);
  }
  const child = spawn("npm", ["start", "--", "-p", String(port)], {
    cwd: path.join(CODE_ROOT, "web"), // the code checkout; CAREER_OPS_PROFILE_DIR (inherited) picks the data
    env: { ...process.env, ANTHROPIC_MODEL: model, CAREER_OPS_WEB_ALLOWED_HOSTS: "" },
    stdio: "ignore",
    detached: true,
  });
  // a killed script takes its detached server with it
  const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
  const onSignal = () => { stop(); process.exit(143); };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) {
      try { await fetch(base, { signal: AbortSignal.timeout(1000) }); break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    return await fn(base);
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    stop();
  }
}

// hunt: Opus spot-checks of lite scores. About 1 in 50 automatic or bulk lite runs (config
// spotcheck_rate in config/ranking.yml, default 0.02) is re-run on Opus, lite scope, same
// prompt, with spotcheck: true so /api/run saves nothing and ranks nothing. Both scores go to
// data/hunt-spotchecks.tsv; Home shows the rolling gap. The Opus score is never used to rank.
export const SPOTCHECK_MODEL = "claude-opus-5-5";

export function chooseSpotchecks(results, rate, rand = Math.random) {
  return results.filter((r) => r.ok && r.report && rand() < rate);
}

function reportScore(root, n) {
  try {
    const f = fs.readdirSync(path.join(root, "reports")).find((x) => x.startsWith(`${String(n).padStart(3, "0")}-`) && x.endsWith(".md"));
    const m = f && fs.readFileSync(path.join(root, "reports", f), "utf8").match(/^\*\*Score:\*\*\s*([\d.]+)/mi);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

export async function runSpotchecks(root, items, { liteModel = "spend_tier", port = WEB_PORT + 10, batch = undefined } = {}) {
  if (!items.length) return [];
  const file = path.join(root, "data", "hunt-spotchecks.tsv");
  if (!fs.existsSync(file)) fs.writeFileSync(file, "date\turl\tcompany\trole\tlite_model\tlite_report\tlite_score\topus_score\tgap\topus_cost_usd\n");
  const out = [];
  await withModelServer(SPOTCHECK_MODEL, port, async (base) => {
    for (const it of items) {
      live(root, { id: `spot:${it.url}`, kind: "spot-check", model: SPOTCHECK_MODEL, company: it.company, role: it.role, url: it.url, state: "running", ...(batch ? { batch } : {}) });
      const started = Date.now();
      const res = await fetch(`${base}/api/run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "evaluate", input: it.url, cliId: "claude", noUsageLog: true, evaluationScope: "lite", spotcheck: true }),
        signal: AbortSignal.timeout(25 * 60 * 1000),
      }).then((r) => r.text()).catch((e) => JSON.stringify({ type: "error", msg: String(e?.message ?? e) }));
      let last = null;
      for (const line of res.split("\n")) { try { const o = JSON.parse(line); if (o.type === "done" || o.type === "error" || o.type === "gated") last = o; } catch {} }
      const opus = typeof last?.spotScore === "number" ? last.spotScore : null;
      const lite = reportScore(root, it.report);
      const gap = opus != null && lite != null ? Math.round((lite - opus) * 10) / 10 : "";
      const clean = (v) => String(v ?? "").replace(/[\t\n]/g, " ");
      fs.appendFileSync(file, [new Date().toISOString(), it.url, it.company, it.role, liteModel, it.report, lite ?? "", opus ?? "", gap, last?.costUsd ?? ""].map(clean).join("\t") + "\n");
      logUsage(root, { date: new Date().toISOString(), model: `${SPOTCHECK_MODEL} (spot-check lite)`, status: last?.type === "done" ? "ok" : `error: ${String(last?.msg ?? last?.reason ?? "").slice(0, 100)}`, secs: Math.round((Date.now() - started) / 1000), tokens: last?.tokens ?? "", cost: last?.costUsd ?? "", report: "", company: it.company, role: it.role, url: it.url });
      live(root, { id: `spot:${it.url}`, state: last?.type === "done" ? "done" : "failed", costUsd: last?.costUsd ?? null }, true);
      out.push({ ...it, lite, opus, gap, cost: last?.costUsd ?? null });
    }
  });
  return out;
}

// hunt: script runs (autoscore, reeval, spot-checks) report their in-progress state to
// data/hunt-runs-live.json so the dashboard's Workers page lists them next to its own runs.
export function live(root, patch, finish = false) {
  const file = path.join(root, "data", "hunt-runs-live.json");
  let doc = {};
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")) ?? {}; } catch {}
  const runs = doc.runs ?? {};
  const now = new Date().toISOString();
  runs[patch.id] = { ...(runs[patch.id] ?? { startedAt: now }), ...patch, updatedAt: now, ...(finish ? { finishedAt: now } : {}) };
  // keep batch rows (Model runs groups by them) and the newest 400 job rows
  const ids = Object.keys(runs).filter((id) => !id.startsWith("batch:")).sort((a, b) => String(runs[b].updatedAt).localeCompare(String(runs[a].updatedAt)));
  for (const id of ids.slice(400)) delete runs[id];
  const tmp = `${file}.tmp-${process.pid}`;
  try { fs.writeFileSync(tmp, JSON.stringify({ runs }, null, 1)); fs.renameSync(tmp, file); } catch {}
}

export function logUsage(root, row) {
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
    : pickCandidates(enrich.jobs, { count: n, perCompany, picker: cfg.auto_score_picker ?? null, target: cfg.target });
  if (dryRun || picks.length === 0) return { picks, results: [] };
  const results = [];
  const retry = [];
  let evalBase = UI;
  for (const p of picks) live(root, { id: `auto:${p.url}`, kind: "lite eval (autoscore)", model: "spend tier", company: p.company, role: p.role, url: p.url, state: "queued" });
  const one = async (p) => {
    live(root, { id: `auto:${p.url}`, state: "running" });
    const r = await evaluate(evalBase, p.url).catch((e) => ({ secs: 0, last: { type: "error", msg: String(e?.message ?? e) }, httpStatus: 0 }));
    const ok = r.last?.type === "done";
    live(root, { id: `auto:${p.url}`, state: ok ? "done" : "failed", costUsd: r.last?.costUsd ?? null, report: r.last?.reportN ?? null }, true);
    logUsage(root, { date: new Date().toISOString(), model: cfg.auto_score_model ? `${cfg.auto_score_model} (auto lite)` : "spend_tier (lite)", status: ok ? "ok" : `error: ${(r.last?.msg ?? `HTTP ${r.httpStatus}`).slice(0, 100)}`, secs: r.secs, tokens: r.last?.tokens ?? "", cost: r.last?.costUsd ?? "", report: r.last?.reportN ?? "", ...p });
    results.push({ ...p, ok, secs: r.secs, msg: r.last?.msg, report: r.last?.reportN ?? null });
    if (!ok && FORMAT_FAILURE.test(r.last?.msg ?? "")) retry.push(p);
  };
  // Worker pool: a slow evaluation no longer holds up the other slots.
  // hunt: config auto_score_model (e.g. claude-sonnet-5-5) runs the automatic lite evals on that
  // model through a loopback-only server, leaving config/profile.yml spend_tier alone. Unset keeps
  // the web's spend tier.
  const pool = async () => {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(parallel, picks.length) }, async () => { while (next < picks.length) await one(picks[next++]); }));
  };
  if (cfg.auto_score_model) await withModelServer(String(cfg.auto_score_model), WEB_PORT + 11, async (base) => { evalBase = base; await pool(); });
  else await pool();
  if (retry.length) {
    await withSonnetServer(root, async (base) => {
      let ri = 0;
      await Promise.all(Array.from({ length: Math.min(parallel, retry.length) }, async () => { while (ri < retry.length) { const p = retry[ri++];
        const r = await evaluate(base, p.url);
        const ok = r.last?.type === "done";
        logUsage(root, { date: new Date().toISOString(), model: "claude-sonnet-5-5 (retry, lite)", status: ok ? "ok" : `error: ${(r.last?.msg ?? `HTTP ${r.httpStatus}`).slice(0, 100)}`, secs: r.secs, tokens: r.last?.tokens ?? "", cost: r.last?.costUsd ?? "", report: r.last?.reportN ?? "", ...p });
        results.push({ ...p, ok, retried: true, secs: r.secs, msg: r.last?.msg });
      } }));
    });
  }
  const rate = Number.isFinite(Number(cfg.spotcheck_rate)) ? Number(cfg.spotcheck_rate) : 0.02;
  const spot = await runSpotchecks(root, chooseSpotchecks(results, rate));
  return { picks, results, spot };
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
