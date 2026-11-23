#!/usr/bin/env node
// hunt-eval-run: one recorded evaluation run, optionally two-pass, with a hard dollar cap
//. The eval hook behind the career-ops MCP's evaluate_jobs / get_eval_run /
// list_eval_runs tools; also usable by hand. Evaluations go through scripts/hunt-reeval.mjs
// (career-ops' normal evaluate flow on a temporary :9964 server), so spend lands in
// data/hunt-usage.tsv and on Workers -> Model runs like any batch.
//
//   plan   [selection] [run options]           JSON: the jobs that would run and the estimate. Spends nothing.
//   start  [selection] [run options] --yes     records data/eval-runs/<id>.json and starts the run detached.
//   run    <id>                                 the detached worker (resumes when restarted).
//   status <id> | list [--limit N]              JSON progress: jobs done/total, spend vs cap, scores 4.0+ first.
//   backlog                                     JSON: judged / not judged / no quick score yet / eligible, and why the rest is skipped.
//
// Selection: --urls-file F (one URL per line) or the default filter:
//   untracked Inbox group leaders not yet evaluated, highest Haiku quick score first (a 1 is
//   skipped; lib/hunt-judge-order.mjs), ties in Best overall order (the dashboard's "true rank"),
//   passing the profile's own filters (config/ranking.yml `target`: levels, location tiers,
//   relocate pay bars, base floor; scripts/hunt-job-filters.mjs, as the daily autoscore uses),
//   not closed.
//   --limit N (default 50), --company NAME, --max-rank N narrow it.
// Run options: --model sonnet-lite | opus-full, --max-spend USD (required),
//   --two-pass-threshold 4.0 --two-pass-model opus-full (pass 2 re-runs pass-1 scores >= threshold,
//   best first, with what is left of the cap), --label TEXT.
// Rules: one run at a time (the :9964 server); `start` needs --yes; a profile whose
// config/ranking.yml has evals_paused: true is refused.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { loadYaml } from "../lib/yaml-document.mjs";
import { trueRank } from "../web/src/lib/hunt-home-v2.mjs";
import { applySignals } from "../web/src/lib/hunt-job-signals.mjs";
import { filterJob } from "./hunt-job-filters.mjs";
import { quickFirst, worthJudging } from "../lib/hunt-judge-order.mjs";
import { gatedUrls, gateHistory } from "../lib/hunt-gate-history.mjs";

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Typical cost per job, measured on real batches (Sonnet lite ~$0.125, Opus full ~$1.85); estimates only.
export const MODELS = {
  "sonnet-lite": { model: "claude-sonnet-5-5", scope: "lite", perJob: 0.125, reserve: 0.35, parallel: 3 },
  "opus-full": { model: "claude-opus-5-5", scope: "full", perJob: 1.85, reserve: 2.5, parallel: 2 },
};
const PASS2_GUESS = 0.15; // share of pass-1 jobs expected at the threshold, for the estimate only
// One run at a time across profiles (they share the :9964 server). Tests point this elsewhere.
const LOCK = process.env.CAREER_OPS_EVAL_LOCK || path.join(CODE, "data", "eval-run.lock");

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };
function writeJson(file, v) { fs.mkdirSync(path.dirname(file), { recursive: true }); const t = `${file}.tmp-${process.pid}`; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, file); }
const runsDir = (root) => path.join(root, "data", "eval-runs");
const manifestPath = (root, id) => path.join(runsDir(root), `${id}.json`);
const money = (n) => Math.round(n * 100) / 100;

export function evalsPaused(root) {
  try { return loadYaml(fs.readFileSync(path.join(root, "config", "ranking.yml"), "utf8"))?.evals_paused === true; } catch { return false; }
}

/** Tracker URLs (any status): a tracked job is never "untracked Inbox". */
function trackedUrls(root) {
  const text = (() => { try { return fs.readFileSync(path.join(root, "data", "applications.md"), "utf8"); } catch { return ""; } })();
  return new Set([...text.matchAll(/https?:\/\/[^\s|)\]]+/g)].map((m) => m[0]));
}

/** Jobs, target, tracker URLs, prior evals and gate history: what selectJobs and scoringBacklog read. */
function selectionContext(root) {
  let target = null;
  try { target = loadYaml(fs.readFileSync(path.join(root, "config", "ranking.yml"), "utf8"))?.target ?? null; } catch { target = null; }
  const doc = readJson(path.join(root, "data", "hunt-enrich.json"), { jobs: {} });
  const jobs = applySignals(structuredClone(doc.jobs ?? {}), { ratings: readJson(path.join(root, "data", "hunt-ratings.json"), {}), liveness: readJson(path.join(root, "data", "hunt-liveness.json"), {}) });
  return {
    target,
    all: jobs,
    ranked: trueRank(jobs),
    tracked: trackedUrls(root),
    prev: readJson(path.join(root, "data", "hunt-prev-fit.json"), {}),
    gated: gatedUrls(root), // stopped at a gate before (lib/hunt-gate-history.mjs)
  };
}

/** filterJob's first reason ("level:staff", "location:tier4", "title", ...) as a skip key. */
function targetReason(reasons) {
  const r = String(reasons?.[0] ?? "");
  if (r.startsWith("level")) return "level";
  if (r.startsWith("location")) return "location";
  if (r === "title") return "title";
  if (r === "contract") return "contract";
  if (/floor/.test(r)) return "below_floor";
  return "target";
}

/**
 * Why the default selection skips a ranked job, or null when it would pick it. One place, so the
 * run and the backlog report (scoringBacklog, the MCP get_scoring_status tool) never disagree.
 */
export function skipReason(e, { target, tracked, prev, gated }) {
  if (e.report || e.fit != null || prev[e.url]?.reeval_ok) return "judged";
  if (tracked.has(e.url) || e.status) return "tracked";
  if (e.excluded) return "hidden";
  if (e.closed) return "closed";
  if (!worthJudging(e)) return "quick_1";
  if (gated.has(e.url)) return "gated";
  if (e.belowFloor) return "below_floor";
  const f = filterJob(e, target);
  if (!f.ok) return targetReason(f.reasons);
  return null;
}

/** The default selection, Best overall order. */
export function selectJobs(root, { limit = 50, company = null, maxRank = null } = {}) {
  const ctx = selectionContext(root);
  const co = company ? String(company).toLowerCase() : null;
  return ctx.ranked.filter((e) => {
    if (skipReason(e, ctx)) return false;
    if (co && !String(e.company ?? "").toLowerCase().includes(co)) return false;
    if (maxRank && e.rank > maxRank) return false;
    return true;
  }).sort(quickFirst((a, b) => a.rank - b.rank)).slice(0, limit).map((e) => ({ url: e.url, company: e.company, role: e.displayRole ?? e.role, rank: e.rank, quick: e.quick_score ?? null }));
}

const SKIP_LABELS = {
  tracked: "in the tracker without a score (added by hand, or applied / discarded before any eval)",
  judged: "already judged by an evaluation",
  hidden: "hidden by the profile's rules (not full-time, or base band below the configured base floor)",
  closed: "posting closed",
  quick_1: "quick score 1: never worth an evaluation",
  gated: "an earlier eval stopped at a gate (dealbreaker or agency: never again; unreadable page: retried after 7 days)",
  below_floor: "base band below the configured base floor",
  level: "outside the configured target levels (config/ranking.yml target.levels)",
  location: "outside the configured target locations (config/ranking.yml target.location_tiers / relocate)",
  title: "title matches target.exclude_titles",
  contract: "not full-time",
  target: "outside the configured target (config/ranking.yml target)",
};

/**
 * What is and isn't scored, for agents that would otherwise read "no score" as broken. Counts
 * dedupe-group leaders only (one row per job, as the Jobs list shows them).
 */
export function scoringBacklog(root) {
  const ctx = selectionContext(root);
  const leaders = ctx.ranked.filter((e) => e.groupLeader !== false);
  const skip = {}, unjudgedByQuick = {}, eligibleByQuick = {};
  const noQuick = [], eligible = [];
  for (const e of leaders) {
    const r = skipReason(e, ctx);
    const q = e.quick_score == null ? "none" : String(e.quick_score);
    if (r !== "judged" && r !== "tracked") unjudgedByQuick[q] = (unjudgedByQuick[q] ?? 0) + 1;
    if (e.quick_score == null && e.fit == null && !e.report) noQuick.push({ e, r });
    if (r) skip[r] = (skip[r] ?? 0) + 1;
    else { eligible.push(e); eligibleByQuick[q] = (eligibleByQuick[q] ?? 0) + 1; }
  }
  const est = estimate(eligible.length, "sonnet-lite");
  const hidden = Object.values(ctx.all).filter((e) => e && e.excluded && e.groupLeader !== false && !e.closed);
  const hiddenWhy = {};
  for (const e of hidden) hiddenWhy[e.excluded] = (hiddenWhy[e.excluded] ?? 0) + 1;
  return {
    jobs: leaders.length,
    hidden_by_rules: { count: hidden.length, by_reason: hiddenWhy, what: "Not full-time, or base band below the configured base floor (exclude_contract / exclude_below_floor): not ranked, not on the Jobs list, never evaluated. Not counted in jobs." },
    judged: skip.judged ?? 0,
    tracked: skip.tracked ?? 0,
    not_judged_by_quick_score: unjudgedByQuick,
    no_quick_score_yet: {
      count: noQuick.length,
      what: "New postings since the last quick-score pass. Not a failure and not a backlog: the daily quick-score job (scripts/hunt-cron.sh autoscore) gives every posting without one a Haiku 1-5 quick score (~$0.003 each, automatic).",
      jobs: noQuick.slice(0, 40).map(({ e, r }) => ({ id: jobIdOf(e.url), company: e.company, title: e.displayRole ?? e.role, true_rank: e.rank, eligible: !r, skipped_because: r ? SKIP_LABELS[r] : null })),
    },
    sonnet_eligible: {
      count: eligible.length,
      by_quick_score: eligibleByQuick,
      estimate_usd: est.pass1,
      what: "Untracked, unjudged jobs the default evaluate_jobs filter would pick, highest quick score first. Only these are worth an evaluation run; everything in skipped_on_purpose is skipped on purpose.",
    },
    skipped_on_purpose: Object.fromEntries(Object.entries(skip).filter(([k]) => k !== "judged" && k !== "tracked").map(([k, n]) => [k, { count: n, why: SKIP_LABELS[k] }])),
  };
}

export function estimate(count, preset, twoPass = null) {
  const p1 = count * MODELS[preset].perJob;
  const p2 = twoPass ? Math.round(count * PASS2_GUESS) * MODELS[twoPass.model].perJob : 0;
  return { pass1: money(p1), pass2: money(p2), total: money(p1 + p2), basis: `${MODELS[preset].perJob}/job${twoPass ? `; pass 2 assumes ${PASS2_GUESS * 100}% reach ${twoPass.threshold} at ${MODELS[twoPass.model].perJob}/job` : ""}` };
}

export function lockHolder() {
  const l = readJson(LOCK, null);
  if (!l?.pid) return null;
  try { process.kill(l.pid, 0); return l; } catch { return null; }
}

function scoreOfReport(root, n) {
  if (!n) return null;
  const dir = path.join(root, "reports");
  const f = (() => { try { return fs.readdirSync(dir).find((x) => x.startsWith(`${String(n).padStart(3, "0")}-`)); } catch { return null; } })();
  if (!f) return null;
  const m = /^\*\*Score:\*\*\s*([0-9.]+)\s*\/\s*5/m.exec(fs.readFileSync(path.join(dir, f), "utf8"));
  return m ? Number(m[1]) : null;
}

/** Results of one pass so far: url -> { score, report, ok } for runs after `since` on `model`. */
// Only evaluations between `since` and `until` (the run's own window): a stopped run must not
// show a later run's results for jobs that run picked up.
function passResults(root, urls, model, since, until = null) {
  const prev = readJson(path.join(root, "data", "hunt-prev-fit.json"), {});
  const out = new Map();
  for (const u of urls) {
    const p = prev[u];
    if (!p || p.reeval_model !== model || !p.reeval_at || p.reeval_at < since || (until && p.reeval_at > until)) continue;
    out.set(u, { ok: p.reeval_ok === true, report: p.reeval_report ?? null, score: p.reeval_ok ? scoreOfReport(root, p.reeval_report) : null });
  }
  return out;
}

const liveBatch = (root, id) => readJson(path.join(root, "data", "hunt-runs-live.json"), {})?.runs?.[`batch:${id}`] ?? null;

/** Progress for one run, from its manifest, its batch rows and the per-job records. */
export function runStatus(root, id) {
  const m = readJson(manifestPath(root, id), null);
  if (!m) return null;
  const p1 = MODELS[m.preset], p2 = m.twoPass ? MODELS[m.twoPass.model] : null;
  const b1 = liveBatch(root, `${id}-p1`), b2 = m.twoPass ? liveBatch(root, `${id}-p2`) : null;
  const until = m.finishedAt ?? null;
  const r1 = passResults(root, m.jobs.map((j) => j.url), p1.model, m.createdAt, m.pass2StartedAt ?? until);
  const r2 = p2 ? passResults(root, m.pass2Urls ?? [], p2.model, m.pass2StartedAt ?? m.createdAt, until) : new Map();
  const spent = money((b1?.costUsd ?? 0) + (b2?.costUsd ?? 0));
  const gates = gateHistory((() => { try { return fs.readFileSync(path.join(root, "data", "hunt-usage.tsv"), "utf8"); } catch { return ""; } })());
  // A failed job is almost always a gate stop (the evaluation read the posting and refused to
  // score it), not an error: "permanent" = dealbreaker or agency, "unreadable" = page didn't load.
  const failKind = (url) => gates.get(url)?.kind ?? "error";
  const STOP = { permanent: "gate: dealbreaker/agency", unreadable: "gate: page unreadable", error: "error" };
  const results = m.jobs.map((j) => {
    const a = r1.get(j.url), b = r2.get(j.url);
    const final = b?.score ?? a?.score ?? null;
    const failed = a && !a.ok;
    return { job_id: j.id, company: j.company, title: j.role, true_rank: j.rank, score: final, pass1_score: a?.score ?? null, pass2_score: b?.score ?? null, report: b?.report ?? a?.report ?? null, failed: failed ? true : undefined, stopped: failed ? STOP[failKind(j.url)] : undefined };
  }).filter((r) => r.pass1_score != null || r.pass2_score != null || r.failed)
    .sort((x, y) => ((y.score ?? 0) >= 4) - ((x.score ?? 0) >= 4) || (y.score ?? -1) - (x.score ?? -1));
  const alive = m.workerPid ? (() => { try { process.kill(m.workerPid, 0); return true; } catch { return false; } })() : false;
  let state = m.state;
  if (["queued", "running", "pass 1", "pass 2"].includes(state) && !alive) state = "stalled (worker not running; restart: node scripts/hunt-eval-run.mjs run " + id + ")";
  return {
    run_id: id, profile: m.profile, label: m.label, state, created_at: m.createdAt, finished_at: m.finishedAt ?? null,
    model: m.preset, two_pass: m.twoPass ?? null,
    jobs_total: m.jobs.length, pass1_done: b1 ? (b1.done ?? 0) + (b1.failed ?? 0) : 0, pass1_failed: b1?.failed ?? 0,
    pass2_total: m.pass2Urls?.length ?? null, pass2_done: b2 ? (b2.done ?? 0) + (b2.failed ?? 0) : 0,
    pass1_failed_breakdown: (() => {
      const c = { gate_dealbreaker_or_agency: 0, gate_page_unreadable: 0, error: 0 };
      const key = { permanent: "gate_dealbreaker_or_agency", unreadable: "gate_page_unreadable", error: "error" };
      for (const r of results) if (r.failed) c[key[failKind(m.jobs.find((j) => j.id === r.job_id)?.url)]]++;
      return c;
    })(),
    failed_means: "Gate stops are the evaluator refusing to score a posting it read (a dealbreaker, an agency, or a page that wouldn't load), not crashes. Don't re-run them: dealbreakers and agencies are never picked again, and unreadable pages are retried automatically after 7 days. Only 'error' entries are real failures.",
    spent_usd: spent, cap_usd: m.capUsd, estimate_usd: m.estimate?.total ?? null, note: m.note ?? null,
    at_or_above_4: results.filter((r) => (r.score ?? 0) >= 4).length, results,
  };
}

export function listRuns(root, limit = 10) {
  let files = [];
  try { files = fs.readdirSync(runsDir(root)).filter((f) => f.endsWith(".json")); } catch {}
  return files.map((f) => f.replace(/\.json$/, "")).map((id) => runStatus(root, id)).filter(Boolean)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit)
    .map(({ results, ...s }) => ({ ...s, top: results.slice(0, 5) }));
}

const jobIdOf = (url) => "j" + crypto.createHash("sha256").update(String(url)).digest("hex").slice(0, 9);

export function planRun(root, { urls = null, limit = 50, company = null, maxRank = null, preset = "sonnet-lite", maxSpend, twoPass = null } = {}) {
  if (!MODELS[preset]) throw new Error(`model must be ${Object.keys(MODELS).join(" or ")}`);
  if (twoPass && !MODELS[twoPass.model]) throw new Error(`two-pass model must be ${Object.keys(MODELS).join(" or ")}`);
  if (!(maxSpend > 0)) throw new Error("--max-spend is required");
  if (evalsPaused(root)) throw new Error("evaluations are paused for this profile (config/ranking.yml evals_paused: true)");
  let jobs;
  if (urls) {
    const enrich = readJson(path.join(root, "data", "hunt-enrich.json"), { jobs: {} }).jobs ?? {};
    jobs = urls.map((u) => ({ url: u, company: enrich[u]?.company ?? "", role: enrich[u]?.displayRole ?? enrich[u]?.role ?? "", rank: null }));
  } else jobs = selectJobs(root, { limit, company, maxRank });
  jobs = jobs.map((j) => ({ id: jobIdOf(j.url), ...j }));
  const est = estimate(jobs.length, preset, twoPass);
  return { jobs, estimate: est, maxSpend, overCap: est.pass1 > maxSpend, preset, twoPass };
}

export function startRun(root, opts, { label = null, profileName = null, spawnWorker = true } = {}) {
  if (lockHolder()) throw new Error(`another evaluation run is active (${lockHolder().id}); one at a time`);
  const plan = planRun(root, opts);
  if (!plan.jobs.length) throw new Error("no jobs match");
  if (plan.overCap) throw new Error(`pass 1 alone is estimated at $${plan.estimate.pass1}, over the $${opts.maxSpend} cap`);
  const id = `ev-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${crypto.randomBytes(2).toString("hex")}`;
  const m = { id, profile: profileName ?? (process.env.CAREER_OPS_PROFILE_DIR ? path.basename(process.env.CAREER_OPS_PROFILE_DIR) : "default"), label: label ?? `${plan.jobs.length} jobs, ${plan.preset}${plan.twoPass ? ` then ${plan.twoPass.model} at ${plan.twoPass.threshold}+` : ""}`, createdAt: new Date().toISOString(), state: "queued", preset: plan.preset, twoPass: plan.twoPass, capUsd: opts.maxSpend, estimate: plan.estimate, jobs: plan.jobs };
  writeJson(manifestPath(root, id), m);
  if (spawnWorker && process.env.CAREER_OPS_EVAL_DRY_SPAWN !== "1") m.spawnedVia = spawnDetached(id, path.join(runsDir(root), `${id}.log`));
  writeJson(manifestPath(root, id), m);
  return { run_id: id, jobs: plan.jobs.length, estimate: plan.estimate, cap_usd: opts.maxSpend };
}

/**
 * Starts the worker outside the caller's process group: as its own systemd user unit when it can
 * (so restarting the MCP service, which starts runs, doesn't kill them), else as a detached
 * session. PATH gets ~/.local/bin, where the claude CLI lives.
 */
function spawnDetached(id, logFile) {
  const home = process.env.HOME || os.homedir();
  const env = { PATH: `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`, HOME: home };
  for (const k of ["CAREER_OPS_PROFILE_DIR", "CAREER_OPS_ROOT", "CAREER_OPS_WEB_PORT"]) if (process.env[k]) env[k] = process.env[k];
  const args = [fileURLToPath(import.meta.url), "run", id];
  // systemd-run --user needs the user bus; a shell without XDG_RUNTIME_DIR (cron, a bare ssh) can't find it.
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const busEnv = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus` };
  const sr = spawnSync("systemd-run", ["--user", "--collect", "--quiet", `--unit=career-ops-${id}`, `--working-directory=${CODE}`,
    `--property=StandardOutput=append:${logFile}`, `--property=StandardError=append:${logFile}`,
    ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), process.execPath, ...args], { encoding: "utf8", timeout: 20000, env: busEnv });
  if (sr.status === 0) return `systemd unit career-ops-${id}`;
  const fd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, args, { cwd: CODE, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  return `detached process ${child.pid} (systemd-run failed: ${(sr.stderr || sr.error?.message || "").trim().slice(0, 120)})`;
}

function reeval(root, id, urls, preset, cap, batchId) {
  const p = MODELS[preset];
  const file = path.join(runsDir(root), `${batchId}.urls.txt`);
  fs.writeFileSync(file, urls.join("\n") + "\n");
  const args = ["scripts/hunt-reeval.mjs", "--urls-file", file, "--model", p.model, "--scope", p.scope, "--cap", String(money(cap)), "--reserve", String(p.reserve), "--parallel", String(p.parallel), "--batch-id", batchId, "--limit-wait", "15", "--limit-max-hours", "6", "--yes"]; // the run was approved at start (--yes)
  console.log(`${new Date().toISOString()} ${id}: ${batchId}: ${urls.length} jobs, ${preset}, cap $${money(cap)}`);
  const r = spawnSync(process.execPath, args, { cwd: CODE, env: process.env, stdio: "inherit" });
  return r.status;
}

/** The detached worker. Restarting it with the same id resumes (hunt-reeval resumes by batch id). */
export function runWorker(root, id) {
  const file = manifestPath(root, id);
  const m = readJson(file, null);
  if (!m) throw new Error(`no run ${id}`);
  if (m.state === "done") return m;
  const held = lockHolder();
  if (held && held.id !== id) throw new Error(`another run is active (${held.id})`);
  writeJson(LOCK, { id, pid: process.pid, at: new Date().toISOString() });
  const save = (patch) => { Object.assign(m, patch); writeJson(file, m); };
  try {
    save({ state: "pass 1", workerPid: process.pid });
    const p1Cap = m.twoPass ? Math.min(m.capUsd, Math.max(m.estimate.pass1 * 1.3, m.estimate.pass1 + 2)) : m.capUsd;
    reeval(root, id, m.jobs.map((j) => j.url), m.preset, p1Cap, `${id}-p1`);
    const spent1 = liveBatch(root, `${id}-p1`)?.costUsd ?? 0;
    if (m.twoPass) {
      const r1 = passResults(root, m.jobs.map((j) => j.url), MODELS[m.preset].model, m.createdAt);
      const rank = new Map(m.jobs.map((j) => [j.url, j.rank ?? 1e9]));
      const pass2 = [...r1].filter(([, r]) => (r.score ?? 0) >= m.twoPass.threshold).sort((a, b) => b[1].score - a[1].score || rank.get(a[0]) - rank.get(b[0])).map(([u]) => u);
      const left = m.capUsd - spent1;
      const fits = Math.floor(left / MODELS[m.twoPass.model].perJob);
      save({ state: "pass 2", pass2Urls: pass2, pass2StartedAt: m.pass2StartedAt ?? new Date().toISOString(), note: pass2.length > fits ? `${pass2.length} reached ${m.twoPass.threshold}; about ${fits} fit in the $${money(left)} left, best first` : null });
      if (pass2.length && left > MODELS[m.twoPass.model].reserve) reeval(root, id, pass2, m.twoPass.model, left, `${id}-p2`);
    }
    spawnSync(process.execPath, ["scripts/hunt-enrich.mjs", "--no-fetch", "--quiet"], { cwd: CODE, env: process.env, stdio: "inherit" });
    save({ state: "done", finishedAt: new Date().toISOString() });
  } catch (e) {
    save({ state: `failed: ${e.message}` });
    throw e;
  } finally {
    if (readJson(LOCK, null)?.pid === process.pid) fs.rmSync(LOCK, { force: true });
  }
  return m;
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
  const cmd = argv[0];
  const root = getCareerOpsRoot();
  const out = (v) => console.log(JSON.stringify(v, null, 1));
  const opts = () => {
    const f = arg("--urls-file", null);
    const t = arg("--two-pass-threshold", null);
    return {
      urls: f ? fs.readFileSync(f === "-" ? 0 : f, "utf8").split(/\s+/).filter(Boolean) : null,
      limit: Number(arg("--limit", 50)), company: arg("--company", null), maxRank: arg("--max-rank", null) ? Number(arg("--max-rank")) : null,
      preset: arg("--model", "sonnet-lite"), maxSpend: Number(arg("--max-spend", NaN)),
      twoPass: t ? { threshold: Number(t), model: arg("--two-pass-model", "opus-full") } : null,
    };
  };
  try {
    if (cmd === "plan") { const p = planRun(root, opts()); out({ ...p, jobs: p.jobs.length, first: p.jobs.slice(0, 10), last: p.jobs.at(-1) }); }
    else if (cmd === "start") { if (!argv.includes("--yes")) throw new Error("start spends money: pass --yes"); out(startRun(root, opts(), { label: arg("--label", null), profileName: arg("--profile-name", null) })); }
    else if (cmd === "run") runWorker(root, argv[1]);
    else if (cmd === "status") { const s = runStatus(root, argv[1]); if (!s) throw new Error(`no run ${argv[1]}`); out(s); }
    else if (cmd === "list") out(listRuns(root, Number(arg("--limit", 10))));
    else if (cmd === "backlog") out(scoringBacklog(root));
    else { console.error("usage: hunt-eval-run.mjs plan|start|run <id>|status <id>|list|backlog"); process.exit(2); }
  } catch (e) { console.error(`hunt-eval-run: ${e.message}`); process.exit(1); }
}
