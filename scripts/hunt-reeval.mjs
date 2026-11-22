#!/usr/bin/env node
// hunt-reeval: re-run career-ops' normal evaluate flow (modes/oferta.md via the web's /api/run)
// for an explicit list of postings on a chosen model, without touching config/profile.yml's
// spend_tier. Runs on a temporary loopback-only web server with ANTHROPIC_MODEL set.
//
// Before each run the job's current fit is saved to data/hunt-prev-fit.json
// ({url: {prev_fit, prev_report, saved_at, reeval_model, reeval_at, reeval_report, reeval_ok}}),
// so the old score survives the re-evaluation (scripts/hunt-enrich.mjs carries it as prev_fit).
// Every run is logged to data/hunt-usage.tsv. A hard dollar cap stops new runs once
// spent + a reserve per in-flight run would pass it.
//
// --scope lite (default) | deep | full: lite is modes/oferta-lite.md (score + level fit); deep/full
// is the full modes/oferta.md evaluation.
// --no-prev skips saving prev_fit (for a test copy of the data, see --root via CAREER_OPS_ROOT).
// Usage: node scripts/hunt-reeval.mjs --urls u1,u2,... [--model claude-opus-5-5] [--scope lite] [--cap 24] [--parallel 1-3] [--reserve 2.5]
import fs from "node:fs";
import path from "node:path";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { evaluate, logUsage, withModelServer, live, chooseSpotchecks, runSpotchecks } from "./hunt-autoscore.mjs";
import { loadYaml } from "../lib/yaml-document.mjs";
import { exitOnHelp, requireSpendConsent } from "../lib/cli-guard.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);
requireSpendConsent("hunt-reeval", { freeFlags: [] });

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const root = getCareerOpsRoot();
const model = arg("--model", "claude-opus-5-5");
const cap = Number(arg("--cap", 24));
const reserve = Number(arg("--reserve", 2.5));
const parallel = Math.max(1, Math.min(4, Number(arg("--parallel", 2))));
const scope = arg("--scope", "lite");
// --urls-file: one URL per line, or a JSON array (a bulk list is too long for the command line).
const urlsFile = arg("--urls-file", "");
const fromFile = urlsFile ? (() => { const t = fs.readFileSync(urlsFile, "utf8").trim(); return t.startsWith("[") ? JSON.parse(t) : t.split("\n"); })() : [];
const urls = [...String(arg("--urls", "")).split(","), ...fromFile].map((u) => String(u).trim()).filter(Boolean);
const port = (Number(process.env.CAREER_OPS_WEB_PORT) || 3000) + 9;
if (!urls.length) { console.error("hunt-reeval: --urls is required"); process.exit(2); }

const enrich = JSON.parse(fs.readFileSync(path.join(root, "data", "hunt-enrich.json"), "utf8")).jobs;
const prevFile = path.join(root, "data", "hunt-prev-fit.json");
const prev = fs.existsSync(prevFile) ? JSON.parse(fs.readFileSync(prevFile, "utf8")) : {};
const savePrev = () => fs.writeFileSync(prevFile, JSON.stringify(prev, null, 2) + "\n");

let spent = 0, inFlight = 0, stopped = false;
const results = [];
// One batch row on Workers → Model runs (web/src/lib/hunt-model-runs.mjs groups by it).
const batchId = arg("--batch-id", `reeval-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const shortModel = model.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2");
const usageLabel = `${model} (reeval ${scope})`;
let pauseNote = null;
const batch = (patch, finish = false) => {
  const done = results.filter((r) => r.ok).length, failed = results.length - done;
  live(root, { id: `batch:${batchId}`, kind: "batch", label: `${shortModel} ${scope} · ${urls.length} jobs`, usageLabel, model, total: urls.length, done, failed, costUsd: Math.round(spent * 100) / 100, capUsd: cap, projectedUsd: results.length ? Math.round((spent / results.length) * urls.length * 100) / 100 : null, ...patch }, finish);
};

// Resume: re-running the same --batch-id skips the jobs it already finished (usage-log rows with
// this label since the batch started) and carries their cost, so the cap stays a batch total.
const resumed = new Set();
try {
  const b = JSON.parse(fs.readFileSync(path.join(root, "data", "hunt-runs-live.json"), "utf8"))?.runs?.[`batch:${batchId}`];
  const since = b?.startedAt ? Date.parse(b.startedAt) : NaN;
  if (Number.isFinite(since)) {
    const want = new Set(urls);
    for (const line of fs.readFileSync(path.join(root, "data", "hunt-usage.tsv"), "utf8").trim().split("\n").slice(1)) {
      const [date, label, status, secs, , cost, report, company, role, url] = line.split("\t");
      if (label !== usageLabel || !want.has(url) || !(Date.parse(date) >= since)) continue;
      spent += Number(cost) || 0;
      if (status === "ok" && !resumed.has(url)) { resumed.add(url); results.push({ url, company, role, ok: true, cost: Number(cost) || 0, secs: Number(secs) || 0, report: report ? Number(report) : null }); }
    }
    if (resumed.size) console.log(`hunt-reeval: resuming ${batchId}: ${resumed.size} already done, $${spent.toFixed(2)} already spent`);
  }
} catch { /* fresh batch */ }

// A usage/rate limit is not a failed job: pause new launches, retry every --limit-wait minutes
// (default 15) until it clears, then carry on. A $0 failure with no tokens and no limit wording
// is retried at most twice (it is usually the limit, sometimes a real failure). Gives up after
// --limit-max-hours (default 6) of waiting.
const LIMIT_RE = /usage limit|hit your (?:\w+ )?limit|limit (?:reached|exceeded)|rate.?limit|quota|\b429\b|overloaded|too many requests|resets? (?:at )?\d/i;
const limitWaitMs = Number(arg("--limit-wait", 15)) * 60_000;
const limitMaxMs = Number(arg("--limit-max-hours", 6)) * 3_600_000;
let pausedUntil = 0, waitedMs = 0;
const silentTries = new Map();
let silentStreak = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retryable = (r) => {
  if (r.last?.type === "done") return false;
  const msg = String(r.last?.msg ?? "");
  if (LIMIT_RE.test(msg)) return "limit";
  return !(Number(r.last?.costUsd) > 0) && !(Number(r.last?.tokens) > 0) ? "silent" : false;
};

batch({ state: "running", finishedAt: undefined });
const queue = urls.filter((u) => !resumed.has(u));
await withModelServer(model, port, async (base) => {
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    while (queue.length && !stopped) {
      // paused on a limit: wait (heartbeat the batch row so Workers does not read it as dead)
      while (Date.now() < pausedUntil && !stopped) { batch({ state: pauseNote ?? "paused (usage limit)" }); await sleep(Math.min(60_000, pausedUntil - Date.now())); }
      if (waitedMs > limitMaxMs) { stopped = true; break; }
      if (!queue.length) break;
      if (spent + (inFlight + 1) * reserve > cap) { stopped = true; break; }
      const url = queue.shift();
      const e = enrich[url] ?? {};
      const p = { url, company: e.company ?? "", role: e.displayRole ?? e.role ?? "" };
      const ownFit = e.fitVia === "group" ? null : e.fit ?? null;
      const old = prev[url] ?? {};
      // A job scored only through its group keeps that score as prev_group_fit, and its quick score as prev_quick.
      prev[url] = { ...old, prev_fit: old.prev_fit ?? ownFit, prev_group_fit: old.prev_group_fit ?? (e.fitVia === "group" ? e.fit ?? null : null), prev_quick: old.prev_quick ?? e.quick_score ?? null, prev_report: old.prev_report ?? e.report?.n ?? null, saved_at: old.saved_at ?? new Date().toISOString(), reeval_model: model, reeval_scope: scope };
      savePrev();
      inFlight++;
      live(root, { id: `reeval:${url}`, kind: `${scope} eval (bulk)`, model, company: p.company, role: p.role, url, state: "running", batch: batchId });
      const r = await evaluate(base, url, { scope: scope === "full" ? "full" : scope }).catch((err) => ({ secs: 0, last: { type: "error", msg: String(err?.message ?? err) }, httpStatus: 0 }));
      inFlight--;
      const ok = r.last?.type === "done";
      const cost = Number(r.last?.costUsd) || 0;
      spent += cost;
      let retry = retryable(r);
      // A run of no-token failures is the usage limit even when the CLI's message does not say so
      // (2026-11-22: every job failed in ~1s with "no <<report-md>> envelope" once the limit hit).
      // Three in a row pause the batch like a limit; those jobs are not charged a try.
      silentStreak = retry === "silent" ? silentStreak + 1 : ok ? 0 : silentStreak;
      if (retry === "silent" && (silentStreak >= 3 || Date.now() < pausedUntil)) retry = "limit";
      const tries = (silentTries.get(url) ?? 0) + (retry === "silent" ? 1 : 0);
      if (retry === "silent" && tries <= 2) {
        // an isolated no-token failure: retry this job later, without pausing the batch
        silentTries.set(url, tries);
        queue.push(url);
        live(root, { id: `reeval:${url}`, state: "queued" });
        console.log(`RETRY later (${tries}/2) ${p.company} — ${p.role} :: ${String(r.last?.msg ?? "").slice(0, 120)}`);
        continue;
      }
      if (retry === "limit") {
        queue.unshift(url);
        live(root, { id: `reeval:${url}`, state: "queued" });
        if (Date.now() >= pausedUntil) {
          pausedUntil = Date.now() + limitWaitMs;
          waitedMs += limitWaitMs;
          pauseNote = `paused (usage limit), retry at ${new Date(pausedUntil).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
          console.log(`PAUSE ${p.company} — ${p.role} :: ${String(r.last?.msg ?? "").slice(0, 160)} :: retry in ${limitWaitMs / 60000} min`);
        }
        batch({ state: pauseNote ?? "paused (usage limit)" });
        continue;
      }
      if (ok && Date.now() >= pausedUntil) { waitedMs = 0; pauseNote = null; }
      logUsage(root, { date: new Date().toISOString(), model: usageLabel, status: ok ? "ok" : `error: ${(r.last?.msg ?? `HTTP ${r.httpStatus}`).slice(0, 100)}`, secs: r.secs, tokens: r.last?.tokens ?? "", cost: r.last?.costUsd ?? "", report: r.last?.reportN ?? "", ...p });
      Object.assign(prev[url], { reeval_at: new Date().toISOString(), reeval_report: r.last?.reportN ?? null, reeval_ok: ok });
      savePrev();
      live(root, { id: `reeval:${url}`, state: ok ? "done" : "failed", costUsd: r.last?.costUsd ?? null, report: r.last?.reportN ?? null }, true);
      results.push({ ...p, ok, cost, secs: r.secs, report: r.last?.reportN, msg: ok ? "" : r.last?.msg });
      batch({ state: "running" });
      console.log(`${ok ? "ok " : "ERR"} $${cost.toFixed(2)} (total $${spent.toFixed(2)}) ${r.secs}s #${r.last?.reportN ?? "-"} ${p.company} — ${p.role}${ok ? "" : ` :: ${r.last?.msg}`}`);
    }
  }));
});
// Opus spot-checks of lite scores (never ranked), inside the same dollar cap.
let spotRate = Number(arg("--spotcheck-rate", NaN));
if (!Number.isFinite(spotRate)) {
  try { spotRate = Number(loadYaml(fs.readFileSync(path.join(root, "config", "ranking.yml"), "utf8"))?.spotcheck_rate ?? 0.02); } catch { spotRate = 0.02; }
}
if (scope === "lite" && model !== "claude-opus-5-5" && spotRate > 0) {
  const spotReserve = Number(arg("--spot-reserve", 0.6));
  const picked = chooseSpotchecks(results, spotRate);
  const room = Math.max(0, Math.floor((cap - spent) / spotReserve));
  const spot = await runSpotchecks(root, picked.slice(0, room), { liteModel: model, port: port + 1, batch: batchId });
  for (const sc of spot) { spent += Number(sc.cost) || 0; console.log(`spot-check ${sc.company}: lite ${sc.lite} vs opus ${sc.opus} (gap ${sc.gap}) $${Number(sc.cost || 0).toFixed(2)}`); }
  if (picked.length > room) console.log(`spot-checks: ${picked.length - room} skipped to stay under the cap`);
}
console.log(`hunt-reeval: ${results.filter((r) => r.ok).length}/${urls.length} ok, $${spent.toFixed(2)} spent${stopped ? (waitedMs > limitMaxMs ? ", stopped: the usage limit did not clear" : `, stopped at the $${cap} cap`) : ""}`);
batch({ state: stopped ? (waitedMs > limitMaxMs ? "stopped: usage limit did not clear" : "stopped at cap") : "done", costUsd: Math.round(spent * 100) / 100 }, true);
