// Tests for scripts/hunt-eval-run.mjs: selection, estimate, status. No spend.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectJobs, estimate, planRun, runStatus, evalsPaused, scoringBacklog } from "../scripts/hunt-eval-run.mjs";

const job = (company, extra = {}) => ({ company, role: `${company} Senior Engineer`, source: "inbox", level: { key: "senior", factor: 1 }, locationTier: 1, fit: null, composite: 50, relevance: 80, quick_score: 4, ...extra });

function ws({ paused = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evalrun-"));
  for (const d of ["data", "config", "reports"]) fs.mkdirSync(path.join(root, d));
  const target = "target:\n  levels: [senior, dual]\n  location_tiers: [1, 2]\n  relocate: { tiers: [3], tc_min: 300000, base_top_min: 250000 }\n";
  fs.writeFileSync(path.join(root, "config", "ranking.yml"), (paused ? "evals_paused: true\n" : "weights: {}\n") + target);
  const jobs = {
    "https://a/1": job("Alpha", { composite: 90 }),
    "https://b/2": job("Beta", { composite: 80, fit: 4.2, report: { n: 1 } }), // evaluated
    "https://c/3": job("Gamma", { composite: 70, locationTier: 3, pay: { currency: "USD", annualMin: 200000, annualMax: 240000 } }), // NYC, too low
    "https://d/4": job("Delta", { composite: 65, locationTier: 3, tc_est: { usd: 320000, rankUsd: 320000 } }), // NYC, TC ok
    "https://e/5": job("Eps", { composite: 60, level: { key: "staff", factor: 0.45 } }), // Staff
    "https://f/6": job("Zeta", { composite: 55, belowFloor: true }),
    "https://g/7": job("Eta", { composite: 50 }), // tracked
    "https://h/8": job("Theta", { composite: 45, locationTier: 4 }), // elsewhere
    "https://i/9": job("Iota", { composite: 40, level: { key: "dual", factor: 0.7 } }), // Senior/Staff ok
  };
  fs.writeFileSync(path.join(root, "data", "hunt-enrich.json"), JSON.stringify({ jobs }));
  fs.writeFileSync(path.join(root, "data", "applications.md"), "| # | Company | URL |\n|---|---|---|\n| 1 | Eta | https://g/7 |\n");
  return root;
}

test("selectJobs follows the profile target filters (levels, tiers, relocate pay bars) in Best overall order", () => {
  const root = ws();
  // Best overall order: Delta's $320k TC puts it in a higher pay band than Alpha.
  assert.deepEqual(selectJobs(root, { limit: 10 }).map((j) => j.company), ["Delta", "Alpha", "Iota"]);
  assert.deepEqual(selectJobs(root, { limit: 1 }).map((j) => j.company), ["Delta"]);
  assert.deepEqual(selectJobs(root, { limit: 10, company: "delt" }).map((j) => j.company), ["Delta"]);
});

test("estimate: pass 1 per job, pass 2 a guessed share at the second model's rate", () => {
  assert.deepEqual(estimate(300, "sonnet-lite"), { pass1: 37.5, pass2: 0, total: 37.5, basis: "0.125/job" });
  const two = estimate(100, "sonnet-lite", { threshold: 4, model: "opus-full" });
  assert.equal(two.pass2, 27.75);
  assert.equal(two.total, 40.25);
});

test("planRun refuses a paused profile and requires a cap", () => {
  assert.throws(() => planRun(ws({ paused: true }), { maxSpend: 5 }), /paused/);
  assert.equal(evalsPaused(ws()), false);
  assert.throws(() => planRun(ws(), {}), /max-spend/);
  const p = planRun(ws(), { maxSpend: 5, limit: 2 });
  assert.equal(p.jobs.length, 2);
  assert.match(p.jobs[0].id, /^j[0-9a-f]{9}$/);
});

test("runStatus: progress, spend vs cap, final score per job with 4.0+ first", () => {
  const root = ws();
  const created = "2026-11-22T12:00:00.000Z";
  fs.mkdirSync(path.join(root, "data", "eval-runs"));
  fs.writeFileSync(path.join(root, "data", "eval-runs", "ev-x.json"), JSON.stringify({ id: "ev-x", profile: "default", createdAt: created, state: "done", preset: "sonnet-lite", twoPass: { threshold: 4, model: "opus-full" }, capUsd: 90, estimate: { total: 50 }, pass2Urls: ["https://a/1"], pass2StartedAt: "2026-11-22T13:00:00.000Z",
    jobs: [{ id: "j1", url: "https://a/1", company: "Alpha", role: "A", rank: 1 }, { id: "j2", url: "https://d/4", company: "Delta", role: "D", rank: 2 }, { id: "j3", url: "https://i/9", company: "Iota", role: "I", rank: 3 }] }));
  fs.writeFileSync(path.join(root, "data", "hunt-runs-live.json"), JSON.stringify({ runs: { "batch:ev-x-p1": { done: 2, failed: 0, costUsd: 0.25 }, "batch:ev-x-p2": { done: 1, failed: 0, costUsd: 1.9 } } }));
  // Alpha: lite 4.1 then Opus 4.3. Delta: lite 3.2. Iota not run yet.
  fs.writeFileSync(path.join(root, "data", "hunt-prev-fit.json"), JSON.stringify({ "https://a/1": { reeval_model: "claude-opus-5-5", reeval_at: "2026-11-22T13:10:00.000Z", reeval_ok: true, reeval_report: 12 }, "https://d/4": { reeval_model: "claude-sonnet-5-5", reeval_at: "2026-11-22T12:30:00.000Z", reeval_ok: true, reeval_report: 11 } }));
  fs.writeFileSync(path.join(root, "reports", "011-delta-2026-11-22.md"), "# Eval\n\n**Score:** 3.2/5\n");
  fs.writeFileSync(path.join(root, "reports", "012-alpha-2026-11-22.md"), "# Eval\n\n**Score:** 4.3/5\n");
  const s = runStatus(root, "ev-x");
  assert.equal(s.spent_usd, 2.15);
  assert.equal(s.cap_usd, 90);
  assert.equal(s.pass1_done, 2);
  assert.equal(s.pass2_total, 1);
  assert.equal(s.at_or_above_4, 1);
  assert.deepEqual(s.results.map((r) => [r.company, r.score]), [["Alpha", 4.3], ["Delta", 3.2]]);
  assert.equal(runStatus(root, "nope"), null);
});

test("selectJobs: highest quick score first, a quick 1 is never picked", () => {
  const root = ws();
  const f = path.join(root, "data", "hunt-enrich.json");
  const doc = JSON.parse(fs.readFileSync(f, "utf8"));
  doc.jobs["https://i/9"].quick_score = 5; // Iota: last by rank, top by quick score
  doc.jobs["https://a/1"].quick_score = 1; // Alpha: skipped
  fs.writeFileSync(f, JSON.stringify(doc));
  assert.deepEqual(selectJobs(root, { limit: 10 }).map((j) => j.company), ["Iota", "Delta"]);
});

test("runStatus: a stopped run never shows results a later run produced", () => {
  const root = ws();
  fs.mkdirSync(path.join(root, "data", "eval-runs"));
  const base = { profile: "default", state: "stopped", preset: "sonnet-lite", twoPass: null, capUsd: 90, estimate: { total: 1 }, jobs: [{ id: "j1", url: "https://a/1", company: "Alpha", role: "A", rank: 1 }, { id: "j2", url: "https://d/4", company: "Delta", role: "D", rank: 2 }] };
  fs.writeFileSync(path.join(root, "data", "eval-runs", "ev-old.json"), JSON.stringify({ ...base, id: "ev-old", createdAt: "2026-11-22T21:00:00.000Z", finishedAt: "2026-11-22T22:15:00.000Z" }));
  fs.writeFileSync(path.join(root, "data", "hunt-prev-fit.json"), JSON.stringify({
    "https://a/1": { reeval_model: "claude-sonnet-5-5", reeval_at: "2026-11-22T21:30:00.000Z", reeval_ok: true, reeval_report: 11 }, // this run
    "https://d/4": { reeval_model: "claude-sonnet-5-5", reeval_at: "2026-11-23T03:30:00.000Z", reeval_ok: true, reeval_report: 12 }, // a later run
  }));
  fs.writeFileSync(path.join(root, "reports", "011-alpha-2026-11-22.md"), "**Score:** 4.1/5\n");
  fs.writeFileSync(path.join(root, "reports", "012-delta-2026-11-22.md"), "**Score:** 4.2/5\n");
  const s = runStatus(root, "ev-old");
  assert.deepEqual(s.results.map((r) => r.company), ["Alpha"]);
});

test("selectJobs skips not-full-time jobs a profile excludes, and jobs an earlier run stopped at a gate", () => {
  const root = ws();
  const f = path.join(root, "data", "hunt-enrich.json");
  const doc = JSON.parse(fs.readFileSync(f, "utf8"));
  doc.jobs["https://a/1"].excluded = "not full-time";
  fs.writeFileSync(f, JSON.stringify(doc));
  fs.writeFileSync(path.join(root, "data", "hunt-usage.tsv"), "date\tmodel\tstatus\tsecs\ttokens\tcost_usd\treport\tcompany\trole\turl\n2026-11-22T10:00:00Z\tclaude-sonnet-5-5 (reeval lite)\terror: gated: dealbreaker: floor\t1\t1\t0.05\t\tDelta\tD\thttps://d/4\n");
  assert.deepEqual(selectJobs(root, { limit: 10 }).map((j) => j.company), ["Iota"]);
});

test("scoringBacklog: every ranked job is judged, eligible, or skipped for a named reason; unscored ones are flagged as new", () => {
  const root = ws();
  const f = path.join(root, "data", "hunt-enrich.json");
  const doc = JSON.parse(fs.readFileSync(f, "utf8"));
  doc.jobs["https://a/1"].quick_score = null; // brand new: no quick score yet, still eligible
  doc.jobs["https://x/10"] = job("Hidden", { excluded: "not full-time" });
  fs.writeFileSync(f, JSON.stringify(doc));
  const b = scoringBacklog(root);
  assert.equal(b.judged, 1);
  assert.equal(b.sonnet_eligible.count, 3); // Alpha, Delta, Iota (as selectJobs)
  assert.equal(b.hidden_by_rules.count, 1);
  assert.equal(b.no_quick_score_yet.count, 1);
  assert.equal(b.no_quick_score_yet.jobs[0].company, "Alpha");
  assert.equal(b.no_quick_score_yet.jobs[0].eligible, true);
  assert.equal(b.skipped_on_purpose.level.count, 1); // Eps (Staff)
  assert.equal(b.skipped_on_purpose.location.count, 2); // Gamma (tier 3 under the relocate bars), Theta
  const skipped = Object.values(b.skipped_on_purpose).reduce((n, x) => n + x.count, 0);
  assert.equal(b.judged + b.tracked + b.sonnet_eligible.count + skipped, b.jobs);
});
