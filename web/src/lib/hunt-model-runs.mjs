// hunt: every model run in one list for the Workers page. Finished runs come from
// data/hunt-usage.tsv (the scripts and /api/run both log there); queued and running script
// runs from data/hunt-runs-live.json (scripts/hunt-autoscore.mjs live()). Read-only.
import fs from "node:fs";
import path from "node:path";

/** "claude-haiku-5-5 (quick score)" → { model, kind } */
export function describeLabel(label) {
  const raw = String(label ?? "");
  const m = raw.match(/^(.*?)\s*\((.*)\)\s*$/);
  const model = (m ? m[1] : raw).trim().replace(/^spend_tier$/, "spend tier") || "spend tier";
  const tag = (m ? m[2] : "").toLowerCase();
  const kind =
    /spot-check/.test(tag) ? "Opus spot-check"
    : /quick/.test(tag) ? "Quick score"
    : /\bdeep\b/.test(tag) ? "Deep dive"
    : /\blite\b/.test(tag) ? (/reeval|bulk/.test(tag) ? "Lite eval (bulk)" : /web/.test(tag) ? "Lite eval" : "Lite eval (auto)")
    : /h2h/.test(tag) ? "Head-to-head"
    : /focused/.test(tag) ? "Focused eval"
    : /reeval|retry|full/.test(tag) || !tag ? "Full eval"
    : tag;
  return { model: model.replace(/^spend tier$/, "spend tier"), kind };
}

function modelName(id) {
  const s = String(id ?? "");
  const m = s.match(/claude-(haiku|sonnet|opus|fable)-(\d+)-(\d+)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : s;
}

const STALE_MS = 30 * 60 * 1000;

/** One usage-log line → a run row. */
function logRow(line) {
  const [date, label, status, secs, tokens, cost, report, company, role, url] = line.split("\t");
  const { model, kind } = describeLabel(label);
  return {
    id: `log:${date}:${url}`, label: String(label ?? ""),
    at: date, kind, model: modelName(model), state: status === "ok" ? "done" : "failed",
    error: status === "ok" ? null : String(status ?? "").replace(/^error:\s*/, ""),
    secs: Number(secs) || null, tokens: Number(tokens) || null, costUsd: Number(cost) || null,
    report: report ? Number(report) || null : null, company: company || "", role: role || "", url: url || "",
  };
}

/**
 * Batches (data/hunt-runs-live.json rows `batch:<id>`, written by scripts/hunt-reeval.mjs)
 * become one parent row each; their job rows (live rows tagged `batch`, the usage-log lines they
 * wrote, and Opus spot-checks of the same jobs inside the batch's time window) nest under it.
 * Everything else stays a single row.
 * @param {string} root
 * @param {{ limit?: number, now?: number }} [opts]
 */
export function readModelRuns(root, { limit = 150, now = Date.now() } = {}) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(root, "data", "hunt-usage.tsv"), "utf8").trim().split("\n").slice(1).filter(Boolean); } catch { /* no log yet */ }
  let live = {};
  try { live = JSON.parse(fs.readFileSync(path.join(root, "data", "hunt-runs-live.json"), "utf8"))?.runs ?? {}; } catch { /* nothing in flight */ }

  // batches and the jobs each one ran
  const batches = new Map();
  for (const [id, r] of Object.entries(live)) {
    if (!id.startsWith("batch:")) continue;
    const bid = id.slice(6);
    const stale = !r.finishedAt && now - Date.parse(r.updatedAt ?? 0) > STALE_MS;
    batches.set(bid, {
      id, type: "batch", batch: bid, label: r.label ?? bid, model: modelName(r.model), usageLabel: r.usageLabel ?? "",
      at: r.startedAt ?? r.updatedAt, startedAt: r.startedAt ?? null, finishedAt: r.finishedAt ?? null, updatedAt: r.updatedAt ?? null,
      state: r.finishedAt ? (/^stopped/.test(String(r.state ?? "")) ? "stopped" : r.failed && !r.done ? "failed" : "done") : stale ? "stopped" : "running",
      status: stale ? "stopped (no update for 30 min)" : String(r.state ?? ""),
      total: Number(r.total) || 0, done: Number(r.done) || 0, failed: Number(r.failed) || 0,
      costUsd: Number(r.costUsd) || 0, capUsd: r.capUsd != null ? Number(r.capUsd) : null, projectedUsd: r.projectedUsd ?? null,
      urls: new Set(), children: [],
    });
  }
  for (const [id, r] of Object.entries(live)) if (r.batch && batches.has(r.batch) && r.url) batches.get(r.batch).urls.add(r.url);
  const window = (b) => [Date.parse(b.startedAt ?? 0) - 60_000, b.finishedAt ? Date.parse(b.finishedAt) + 60_000 : Infinity];
  const batchOf = (row) => {
    if (!row.url) return null;
    const t = Date.parse(row.at);
    for (const b of batches.values()) {
      if (!b.urls.has(row.url)) continue;
      const [a, z] = window(b);
      if (!(t >= a && t <= z)) continue;
      if (row.label === b.usageLabel || /spot-check/.test(row.label)) return b;
    }
    return null;
  };

  const singles = [];
  for (const line of lines) {
    const row = logRow(line);
    const b = batches.size ? batchOf(row) : null;
    if (b) b.children.push(row); else singles.push(row);
  }
  const loggedRuns = singles.slice(-limit);
  for (const [id, r] of Object.entries(live)) {
    if (id.startsWith("batch:")) continue;
    if (r.state !== "queued" && r.state !== "running") continue;
    // a run that said nothing for 30 minutes died with its script
    if (now - Date.parse(r.updatedAt ?? 0) > STALE_MS) continue;
    const row = { id, at: r.updatedAt, kind: r.kind ?? "Run", model: modelName(r.model), state: r.state, error: null, secs: null, tokens: null, costUsd: null, report: null, company: r.company ?? "", role: r.role ?? "", url: r.url ?? "" };
    const b = r.batch ? batches.get(r.batch) : batchOf({ ...row, label: String(r.kind ?? "") });
    if (b) b.children.push(row); else loggedRuns.push(row);
  }

  const order = (a, b) => {
    const rank = (x) => (x.state === "running" ? 0 : x.state === "queued" ? 1 : 2);
    return rank(a) - rank(b) || String(b.at).localeCompare(String(a.at));
  };
  const parents = [...batches.values()].map(({ urls, usageLabel, ...b }) => {
    // a failed try of a job that later succeeded in the same batch is noise (a retried usage-limit hit)
    const okAt = new Map();
    for (const c of b.children) if (c.state === "done" && c.url && c.kind !== "Opus spot-check") okAt.set(c.url, Math.max(okAt.get(c.url) ?? 0, Date.parse(c.at) || 0));
    b.children = b.children.filter((c) => !(c.state === "failed" && c.kind !== "Opus spot-check" && okAt.get(c.url) > (Date.parse(c.at) || 0)));
    b.children.sort(order);
    const spot = b.children.filter((c) => c.kind === "Opus spot-check");
    b.spotchecks = spot.length;
    // the live row's cost covers the script's own count; the log is the fallback
    const logged = b.children.reduce((s, c) => s + (c.costUsd ?? 0), 0);
    b.costUsd = Math.round(Math.max(b.costUsd, logged) * 100) / 100;
    return b;
  });
  const runs = [...loggedRuns, ...parents].sort(order);
  // the server's local day (the log stores UTC timestamps)
  const today = new Date(now).toDateString();
  const flat = [...loggedRuns, ...parents.flatMap((b) => b.children)];
  const todayCost = flat.filter((r) => new Date(r.at).toDateString() === today).reduce((s, r) => s + (r.costUsd ?? 0), 0);
  return { runs: runs.map((r) => (r.type === "batch" ? { ...r, children: r.children.map(({ label: _l, ...c }) => c) } : (({ label: _l, ...x }) => x)(r))), todayCost: Math.round(todayCost * 100) / 100 };
}

/** Rolling Opus spot-check line for Home: count, mean gap, warning over 0.5. */
export function readSpotchecks(root, { window = 20 } = {}) {
  try {
    const rows = fs.readFileSync(path.join(root, "data", "hunt-spotchecks.tsv"), "utf8").trim().split("\n").slice(1)
      .map((l) => l.split("\t")).filter((r) => r[8] !== "" && Number.isFinite(Number(r[8])));
    if (!rows.length) return null;
    const recent = rows.slice(-window).map((r) => Number(r[8]));
    const meanAbs = recent.reduce((s, g) => s + Math.abs(g), 0) / recent.length;
    const mean = recent.reduce((s, g) => s + g, 0) / recent.length;
    return { n: rows.length, window: recent.length, meanAbsGap: Math.round(meanAbs * 100) / 100, meanGap: Math.round(mean * 100) / 100, warn: meanAbs > 0.5 };
  } catch { return null; }
}
